/**
 * Savings is the profile's sUSDS asset: an oxide deployment of its own in the same manifest, with its
 * own portal, L2 token (zk-sUSDS) and enclave. Its runtime is the network's with that deployment
 * swapped in, so code that reads `rt.tuple` and `rt.tokenService()` runs against it unchanged. The
 * store stays the network's: withdrawal records carry the deployment they burned on.
 *
 * A move between Main and Savings burns into a `SkyEscrow` on the source deployment. The burn's tx
 * broadcasts the release and the escrow's run; the run deposits into the destination portal under a
 * commitment this account derived, and the account then claims that deposit.
 */
import { randomBytes } from "node:crypto"
import { EthAddress } from "@aztec/aztec.js/addresses"
import { Fr } from "@aztec/aztec.js/fields"
import { AztecAddress } from "@aztec/stdlib/aztec-address"
import { loadOxideManifestTuple } from "@obsidion/core/oxide"
import { DEFAULT_DECIMALS } from "@obsidion/core/constants"
import {
  BroadcasterContract,
  TokenService,
  buildSkyEscrowRecoverCall,
  buildSkyEscrowRunCall,
  nextOperationId,
  quoteSkyEscrowTip,
  quoteSkyReleaseTip,
  readPortalWithdrawalState,
} from "@obsidion/sdk"
import {
  SkyEscrowFactoryAbi,
  SkyRoute,
  escrowERC20RecoveryDigest,
  predictSkyEscrowAddressLocally,
  type SkyEscrowArgs,
} from "@oxide/l1-contracts"
import { OxidePortalAbi } from "@oxide/l1-contracts/abis/OxidePortal.js"
import { buildSkyEscrowWithdrawal } from "@oxide/oxide-client/withdraw_escrows/sky.js"
import { computeRecipientCommitment } from "@oxide/oxide-lib/recipient_commitment.js"
import { deriveRecoveryCommitment } from "@oxide/oxide-lib/sipa_recovery.js"
import {
  createWalletClient,
  erc20Abi,
  erc4626Abi,
  formatUnits,
  http,
  type Address,
  type Hex,
} from "viem"
import { privateKeyToAccount } from "viem/accounts"
import {
  createOxideL1Reader,
  createOxideTeeSignerSource,
  deriveBootstrapKey,
  deriveSkyEscrowSalts,
  isSavingsMovePending,
  settleSavingsMove,
  type SavingsMove,
  resolveOxideAccountFactory,
  signAccountDigest,
} from "../frontCore.ts"
import { amount as formatAmount, fail, note } from "../output.ts"
import type { Runtime } from "./boot.ts"
import { quoteFasterProof, type FasterProof } from "./fasterProof.ts"
import { Records } from "./records.ts"
import { oxideAccountPasskey, registrationKeysOf } from "./registration.ts"
import { activateNetwork, parseSendAmount, sponsorOrFail } from "./send.ts"
import { keysOf, noteSubscribed } from "./sponsor.ts"
import {
  currentDeployment,
  fpcFundingCut,
  runBurn,
  tuplePortal,
  withdrawalTracker,
  type WithdrawStage,
} from "./withdraw.ts"

export async function savingsRuntime(rt: Runtime): Promise<Runtime> {
  const pin = rt.config.assets.sUSDS?.value
  if (!pin)
    fail(
      `the ${rt.network} profile lists no sUSDS asset`,
      "`zkmoney config set addresses.sUSDSPortal <portal>` names a Sky deployment to test against",
    )
  const tuple = await loadOxideManifestTuple({
    manifestUrl: pin.manifestUrl ?? rt.config.oxide.manifestUrl,
    portal: pin.portal,
    network: rt.network,
    expectedGitSha: pin.expectedGitSha,
  })
  const l2Token = AztecAddress.fromStringUnsafe(tuple.l2Token)
  let tokenPromise: Promise<TokenService> | undefined
  return {
    ...rt,
    tuple,
    env: () => fail("savings registers no names"),
    tokenService() {
      tokenPromise ??= (async () => {
        const { account } = await rt.account()
        const service = await TokenService.create(rt.wallet, account, l2Token)
        const signer = await createOxideTeeSignerSource({
          l1RpcUrl: rt.config.l1RpcUrl.value,
          l1Chain: rt.l1Chain,
          getNode: () => rt.node,
          getTokenAddress: async () => l2Token,
          getTuple: () => tuple,
        }).load()
        if (!signer)
          note("note: the savings co-signer is not reachable; savings transfers will fail")
        else service.setTeeSigner(signer)
        return service
      })()
      return tokenPromise
    },
  }
}

export interface SavingsPosition {
  /** zk-sUSDS held privately. */
  shares: bigint
  /** USDS the shares redeem for at Sky's current price; 1 USDS is 1 DAI. */
  value: bigint
  /** Yearly yield from Sky's savings rate; undefined where the sUSDS contract publishes none. */
  apy: number | undefined
}

const RAY = 10n ** 27n
const SECONDS_PER_YEAR = 365 * 24 * 60 * 60
const ssrAbi = [
  {
    type: "function",
    name: "ssr",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
] as const

/** Sky's per-second savings rate (a ray) compounded over a year. */
export const apyFromSsr = (ssr: bigint): number =>
  Math.expm1(SECONDS_PER_YEAR * Math.log1p(Number(ssr - RAY) / 1e27))

/** The savings position from a runtime `savingsRuntime` made. */
export async function readSavings(sv: Runtime): Promise<SavingsPosition> {
  const shares = await (await sv.tokenService()).getBalance()
  const sUsds = (await sv.l1.readContract({
    address: sv.tuple.portal as Address,
    abi: OxidePortalAbi,
    functionName: "UNDERLYING",
  })) as Address
  const [value, ssr] = await Promise.all([
    sv.l1.readContract({
      address: sUsds,
      abi: erc4626Abi,
      functionName: "convertToAssets",
      args: [shares],
    }),
    sv.l1.readContract({ address: sUsds, abi: ssrAbi, functionName: "ssr" }).catch(() => undefined),
  ])
  return { shares, value, apy: ssr === undefined ? undefined : apyFromSsr(ssr) }
}

export type { SavingsMove }

export const SAVINGS_MOVE_KIND = "savings-move"

interface SkyFactory {
  address: Address
  dai: Address
  sUsds: Address
}

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** The profile's Sky escrow factory, checked to move between this wallet's DAI and sUSDS deployments. */
async function skyFactory(rt: Runtime, sv: Runtime): Promise<SkyFactory> {
  const address = rt.config.skyEscrowFactory.value as Address | undefined
  if (!address)
    fail(
      `the ${rt.network} profile names no Sky escrow factory`,
      "`zkmoney config set addresses.skyEscrowFactory <address>` names one to test against",
    )
  const read = (functionName: "DAI" | "DAI_PORTAL" | "SUSDS" | "SUSDS_PORTAL") =>
    rt.l1.readContract({ address, abi: SkyEscrowFactoryAbi, functionName }) as Promise<Address>
  const [dai, daiPortal, sUsds, sUsdsPortal] = await Promise.all([
    read("DAI"),
    read("DAI_PORTAL"),
    read("SUSDS"),
    read("SUSDS_PORTAL"),
  ])
  if (!sameAddress(daiPortal, rt.tuple.portal) || !sameAddress(sUsdsPortal, sv.tuple.portal))
    fail(
      `the Sky escrow factory ${address} moves between ${daiPortal} and ${sUsdsPortal}, ` +
        `not this wallet's ${rt.tuple.portal} and ${sv.tuple.portal}`,
    )
  return { address, dai, sUsds }
}

/** The L1 account whose signature recovers a move's escrow: this account's OxideAccount. */
export async function recoveryAccountOf(rt: Runtime): Promise<Address> {
  const keys = await keysOf(rt)
  return (await createOxideL1Reader(rt.l1).predictAccountAddress(
    resolveOxideAccountFactory({ tuple: rt.tuple }),
    deriveBootstrapKey(keys.secretKey).address,
  )) as Address
}

export const newMoveId = () =>
  `mv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

/**
 * Burn `amountAtomic` of the source token into a Sky escrow: DAI from Main moving in, sUSDS shares from
 * Savings moving out. The burn is all this sends; the relayer releases it and runs the escrow.
 */
export async function moveThroughSky(
  rt: Runtime,
  sv: Runtime,
  input: { direction: "in" | "out"; amountAtomic: bigint; key?: string; faster?: boolean },
  onStage: (stage: WithdrawStage) => void,
): Promise<{ id: string; move: SavingsMove; replayed: boolean; faster?: FasterProof }> {
  const into = input.direction === "in"
  if (input.faster && !into)
    fail("a move out of Savings cannot buy an early proof", "its prover would be paid in sUSDS")
  const source = into ? rt : sv
  onStage("building")
  await activateNetwork(rt)
  const factory = await skyFactory(rt, sv)
  const tokenService = await source.tokenService()
  const balance = await tokenService.getBalance()
  const symbol = into ? "DAI" : "sUSDS"
  if (balance < input.amountAtomic)
    fail(
      `the ${into ? "Main" : "Savings"} balance is ${formatAmount(
        balance,
        DEFAULT_DECIMALS,
        symbol,
      )}`,
    )
  const route = into ? SkyRoute.Stake : SkyRoute.Unstake
  const { relayerTip: releaseTip } = await quoteSkyReleaseTip(
    rt.l1 as never,
    tuplePortal(source.tuple, "withdrawalSubsidy"),
    route,
  )
  const cut = await fpcFundingCut(source)
  const faster = input.faster ? await quoteFasterProof(rt) : undefined
  const proverTip = faster?.proverTip ?? 0n
  const released = into
    ? input.amountAtomic - cut - proverTip
    : await rt.l1.readContract({
        address: factory.sUsds,
        abi: erc4626Abi,
        functionName: "convertToAssets",
        args: [input.amountAtomic - cut],
      })
  const escrowFunding = released - releaseTip
  if (escrowFunding <= 0n)
    fail(
      `the amount does not cover the release fee of ${formatAmount(
        releaseTip + cut + proverTip,
        DEFAULT_DECIMALS,
        "DAI",
      )}`,
    )
  const tip = await quoteSkyEscrowTip(
    rt.l1 as never,
    {
      skyEscrowFactory: factory.address,
      operationExecutor: tuplePortal(rt.tuple, "operationExecutor"),
      dai: factory.dai,
      withdrawalSubsidy: tuplePortal(source.tuple, "withdrawalSubsidy"),
    },
    {
      route,
      escrowFunding,
      sender: factory.address,
    },
  )
  const { unlocked, account } = await rt.account()
  const records = new Records(rt.storage)
  const id = input.key ?? newMoveId()
  const args = { direction: input.direction, amount: input.amountAtomic.toString() }
  // The tracker settles every deployment's burns; the network's own deployment arms it first.
  await withdrawalTracker(rt)
  const handle = await records.once<SavingsMove>(SAVINGS_MOVE_KIND, id, args, async () => {
    const sponsor = await sponsorOrFail(rt, unlocked.file.identity?.tag)
    const nonce = Fr.random().toString() as Hex
    const salts = deriveSkyEscrowSalts(unlocked.masterSecret, nonce)
    const recipientCommitment = (
      await computeRecipientCommitment(salts.recipient, account.getAddress())
    ).toString() as Hex
    const recoveryAccount = await recoveryAccountOf(rt)
    const broadcasterAddress = tuplePortal(source.tuple, "l2Broadcaster")
    const built = buildSkyEscrowWithdrawal({
      broadcaster: BroadcasterContract.at(
        AztecAddress.fromStringUnsafe(broadcasterAddress),
        await rt.broadcasterArtifact(broadcasterAddress),
        rt.wallet as never,
      ),
      skyEscrowFactory: EthAddress.fromString(factory.address),
      dai: EthAddress.fromString(factory.dai),
      from: account.getAddress(),
      plainWithdrawalExecutor: EthAddress.fromString(
        tuplePortal(source.tuple, "plainWithdrawalExecutor"),
      ),
      amount: input.amountAtomic,
      withdrawalRelayerTip: releaseTip,
      proverTip,
      fpcFundingCut: cut,
      route,
      recipientCommitment,
      recoveryAccount: EthAddress.fromString(recoveryAccount),
      relayerTip: tip.relayerTip,
      nonce,
      recoverySalt: salts.recovery,
    })
    if (built.operation.kind !== "withdraw") fail("the Sky escrow built no withdrawal")
    const userPayload = built.operation.userPayload
    const portal = await readPortalWithdrawalState(rt.l1 as never, source.tuple.portal as Address)
    const operationId = nextOperationId("withdraw")
    const { record, mined } = await runBurn(source, {
      operationId,
      record: {
        recipient: built.escrow.toString(),
        recipientProvenance: "saved-recipient",
        amount: formatUnits(input.amountAtomic, DEFAULT_DECIMALS),
        rawAmount: input.amountAtomic.toString(),
        relayerTip: releaseTip.toString(),
        proverTip: proverTip.toString(),
        fpcFundingCut: cut.toString(),
        tokenSymbol: symbol,
        phase: "submitting",
        startTime: Date.now(),
        deployment: currentDeployment(source),
      },
      burn: () => {
        onStage("proving")
        return tokenService.exitToL1PrivateSponsored(
          built.escrow,
          input.amountAtomic.toString(),
          sponsor,
          {
            operationId,
            userAccount: account,
            useRawAmount: true,
            proverTip,
            withdrawal: {
              tuple: source.tuple,
              portal,
              escrow: { escrow: built.escrow, userPayload, l1Operation: built.l1Operation },
            },
          },
        )
      },
    })
    if (mined && sponsor.subscribe) noteSubscribed(account, sponsor)
    onStage("submitting")
    return {
      direction: input.direction,
      withdrawalLocalId: record.localId,
      escrow: built.escrow.toString() as Address,
      nonce,
      recipientCommitment,
      amount: input.amountAtomic.toString(),
      releaseTip: releaseTip.toString(),
      escrowTip: tip.relayerTip.toString(),
      ...(proverTip ? { proverTip: proverTip.toString() } : {}),
    }
  })
  return { id, move: handle.result, replayed: handle.replayed, faster }
}

/** The shares that redeem for `value` USDS at Sky's current price. */
export async function sharesFor(sv: Runtime, value: bigint): Promise<bigint> {
  const sUsds = (await sv.l1.readContract({
    address: sv.tuple.portal as Address,
    abi: OxidePortalAbi,
    functionName: "UNDERLYING",
  })) as Address
  return sv.l1.readContract({
    address: sUsds,
    abi: erc4626Abi,
    functionName: "convertToShares",
    args: [value],
  })
}

/**
 * Each move's destination deposit, found once its escrow has run, and claimed into this account's
 * balance. A claim that fails is tried again next time: the deposit's message may not have reached
 * L2 yet.
 */
/** Claims Savings deposits that reached L2, so a sync credits a move as it credits a swept deposit. */
export async function settlePendingSavings(rt: Runtime): Promise<void> {
  if (!rt.config.assets.sUSDS) return
  const records = await new Records(rt.storage).list<SavingsMove>(SAVINGS_MOVE_KIND)
  if (!records.some(({ result }) => result && isSavingsMovePending(result))) return
  await settleMoves(rt, await savingsRuntime(rt))
}

export async function settleMoves(
  rt: Runtime,
  sv: Runtime,
): Promise<{ id: string; move: SavingsMove }[]> {
  const records = new Records(rt.storage)
  const { unlocked, account } = await rt.account()
  const destination = (side: Runtime) => ({
    portal: side.tuple.portal as Address,
    fromBlock: BigInt(side.tuple.deployedAtBlock ?? 0),
    claimer: () => side.tokenService(),
  })
  const deps = {
    publicClient: rt.l1 as never,
    masterSecret: unlocked.masterSecret,
    recipient: account.getAddress(),
    main: destination(rt),
    savings: destination(sv),
  }
  const moves: { id: string; move: SavingsMove }[] = []
  for (const record of await records.list<SavingsMove>(SAVINGS_MOVE_KIND)) {
    if (!record.result) continue
    const { move, claimError } = await settleSavingsMove(record.result, deps)
    if (claimError && process.env.ZKMONEY_DEBUG)
      note(
        `claim for ${move.escrow}: ${
          claimError instanceof Error ? claimError.message : String(claimError)
        }`,
      )
    if (move !== record.result) await records.put({ ...record, result: move })
    moves.push({ id: record.key, move })
  }
  return moves
}

/** How long a recovery signature stays valid, in chain seconds: it is sent at once. */
const RECOVERY_DEADLINE_S = 60n * 60n

/**
 * The two exits from a move whose escrow nobody ran, both sent from `privateKey`, which pays the gas.
 * Without `to`, run the escrow, which completes the move and pays the sender its tip. With `to`,
 * send what the escrow holds there instead, signed by this account's OxideAccount.
 */
export async function exitMove(
  rt: Runtime,
  sv: Runtime,
  input: { id: string; to?: Address },
  privateKey: Hex,
): Promise<{ txHashes: Hex[] }> {
  const records = new Records(rt.storage)
  const record = await records.get<SavingsMove>(SAVINGS_MOVE_KIND, input.id)
  const move = record?.result
  if (!record || !move)
    fail(`no savings move "${input.id}"`, "`zkmoney savings` lists the ones in flight")
  if (move.deposit) fail("this move's escrow already ran; `zkmoney savings` claims its deposit")
  if (move.recovered) fail(`this move's escrow was already recovered to ${move.recovered.to}`)
  const factory = await skyFactory(rt, sv)
  const { unlocked } = await rt.account()
  const salts = deriveSkyEscrowSalts(unlocked.masterSecret, move.nonce)
  const recovery = { account: await recoveryAccountOf(rt), salt: salts.recovery }
  const args: SkyEscrowArgs = {
    route: move.direction === "in" ? SkyRoute.Stake : SkyRoute.Unstake,
    recipientCommitment: move.recipientCommitment,
    recoveryCommitment: deriveRecoveryCommitment(
      salts.recovery,
      EthAddress.fromString(recovery.account),
    ).toString() as Hex,
    relayerTip: BigInt(move.escrowTip),
    nonce: move.nonce,
  }
  if (!sameAddress(predictSkyEscrowAddressLocally(factory.address, args), move.escrow))
    fail(`this account's keys do not rebuild escrow ${move.escrow}`)
  const held = (token: Address) =>
    rt.l1.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [move.escrow],
    })
  const [dai, shares] = await Promise.all([held(factory.dai), held(factory.sUsds)])
  if (dai === 0n && shares === 0n)
    fail(
      "the escrow holds nothing: the burn has not been released to it yet",
      "`zkmoney withdrawals list` shows the burn's progress",
    )
  const wallet = createWalletClient({
    account: privateKeyToAccount(privateKey),
    chain: rt.l1Chain,
    transport: http(rt.config.l1RpcUrl.value, { timeout: 20_000 }),
  })
  const send = async (call: { to: Address; data: Hex }) => {
    const hash = await wallet.sendTransaction({ to: call.to, data: call.data })
    const receipt = await rt.l1.waitForTransactionReceipt({ hash })
    if (receipt.status !== "success") fail(`transaction ${hash} reverted`)
    return hash
  }
  if (!input.to) {
    if (dai <= args.relayerTip)
      fail(
        "the escrow holds no more DAI than its tip, so running it would move nothing",
        "send what it holds to an Ethereum address with --to",
      )
    return { txHashes: [await send(buildSkyEscrowRunCall(factory.address, args))] }
  }
  const keys = await registrationKeysOf(rt)
  const signing = {
    account: recovery.account,
    chainId: rt.config.l1ChainId,
    reader: createOxideL1Reader(rt.l1),
    passkey: await oxideAccountPasskey(keys.provider),
    bootstrap: deriveBootstrapKey(keys.secretKey),
  }
  const txHashes: Hex[] = []
  for (const [token, amount] of [
    [factory.dai, dai],
    [factory.sUsds, shares],
  ] as const) {
    if (amount === 0n) continue
    const nonce = `0x${randomBytes(32).toString("hex")}` as Hex
    const deadline = (await rt.l1.getBlock({ blockTag: "latest" })).timestamp + RECOVERY_DEADLINE_S
    const hash = escrowERC20RecoveryDigest(
      move.escrow,
      BigInt(rt.config.l1ChainId),
      input.to,
      token,
      nonce,
      deadline,
    )
    const code = await rt.l1.getCode({ address: move.escrow })
    const call = buildSkyEscrowRecoverCall({
      deployed: !!code && code !== "0x",
      factory: factory.address,
      escrow: move.escrow,
      args,
      recovery,
      signature: await signAccountDigest({ ...signing, hash }),
      target: input.to,
      token,
      nonce,
      deadline,
    })
    txHashes.push(await send(call))
  }
  await records.put({ ...record, result: { ...move, recovered: { to: input.to, txHashes } } })
  return { txHashes }
}
