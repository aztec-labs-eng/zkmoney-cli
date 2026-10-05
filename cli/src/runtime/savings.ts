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
import { EthAddress } from "@aztec/aztec.js/addresses"
import { Fr } from "@aztec/aztec.js/fields"
import { AztecAddress } from "@aztec/stdlib/aztec-address"
import { loadOxideManifestTuple } from "@obsidion/core/oxide"
import { DEFAULT_DECIMALS, WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import {
  BroadcasterContract,
  TokenService,
  nextOperationId,
  quoteSkyEscrowTip,
  readPortalWithdrawalState,
} from "@obsidion/sdk"
import { SkyEscrowFactoryAbi, SkyRoute } from "@oxide/l1-contracts"
import { OxidePortalAbi } from "@oxide/l1-contracts/abis/OxidePortal.js"
import { buildSkyEscrowWithdrawal } from "@oxide/oxide-client/withdraw_escrows/sky.js"
import { computeRecipientCommitment } from "@oxide/oxide-lib/recipient_commitment.js"
import { erc4626Abi, formatUnits, type Address, type Hex } from "viem"
import {
  createOxideL1Reader,
  createOxideTeeSignerSource,
  deriveBootstrapKey,
  deriveSkyEscrowSalts,
  resolveOxideAccountFactory,
} from "../frontCore.ts"
import { amount as formatAmount, fail, note } from "../output.ts"
import type { Runtime } from "./boot.ts"
import { Records } from "./records.ts"
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
    manifestUrl: rt.config.oxide.manifestUrl,
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

export const SAVINGS_MOVE_KIND = "savings-move"

/**
 * The DAI tip a Savings-to-Main release offers. The Sky executor redeems before it pays, beyond the
 * plain release the withdrawal subsidy models, and its gas is not measured yet, so this is a flat
 * bound above the plain release tip.
 */
const SKY_RELEASE_TIP = 3n * WITHDRAW_RELAYER_TIP

export interface SavingsMove {
  direction: "in" | "out"
  /** The burn's withdrawal record. */
  withdrawalLocalId: string
  escrow: Address
  nonce: Hex
  recipientCommitment: Hex
  /** What was burned, in the source token's base units: DAI moving in, sUSDS shares moving out. */
  amount: string
  /** The DAI the escrow pays whoever runs it. */
  escrowTip: string
  /** The destination portal's deposit once the escrow has run, and whether this account claimed it. */
  deposit?: { inboxIndex: string; amount: string; claimed: boolean }
}

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

export const newMoveId = () =>
  `mv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

/**
 * Burn `amountAtomic` of the source token into a Sky escrow: DAI from Main moving in, sUSDS shares from
 * Savings moving out. The burn is all this sends; the relayer releases it and runs the escrow.
 */
export async function moveThroughSky(
  rt: Runtime,
  sv: Runtime,
  input: { direction: "in" | "out"; amountAtomic: bigint; key?: string },
  onStage: (stage: WithdrawStage) => void,
): Promise<{ id: string; move: SavingsMove; replayed: boolean }> {
  const into = input.direction === "in"
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
  const releaseTip = into ? WITHDRAW_RELAYER_TIP : SKY_RELEASE_TIP
  const cut = await fpcFundingCut(source)
  const released = into
    ? input.amountAtomic - cut
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
        releaseTip + cut,
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
      route: into ? SkyRoute.Stake : SkyRoute.Unstake,
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
    const keys = await keysOf(rt)
    const recoveryAccount = await createOxideL1Reader(rt.l1).predictAccountAddress(
      resolveOxideAccountFactory({ tuple: rt.tuple }),
      deriveBootstrapKey(keys.secretKey).address,
    )
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
      proverTip: 0n,
      fpcFundingCut: cut,
      route: into ? SkyRoute.Stake : SkyRoute.Unstake,
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
      escrowTip: tip.relayerTip.toString(),
    }
  })
  return { id, move: handle.result, replayed: handle.replayed }
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
export async function settleMoves(rt: Runtime, sv: Runtime): Promise<SavingsMove[]> {
  const records = new Records(rt.storage)
  const { unlocked, account } = await rt.account()
  const moves: SavingsMove[] = []
  for (const record of await records.list<SavingsMove>(SAVINGS_MOVE_KIND)) {
    let move = record.result
    if (!move) continue
    const destination = move.direction === "in" ? sv : rt
    if (!move.deposit) {
      const [log] = await rt.l1.getContractEvents({
        address: destination.tuple.portal as Address,
        abi: OxidePortalAbi,
        eventName: "Deposit",
        args: { recipientCommitment: move.recipientCommitment },
        fromBlock: BigInt(destination.tuple.deployedAtBlock ?? 0),
      })
      if (log)
        move = {
          ...move,
          deposit: {
            inboxIndex: log.args.index!.toString(),
            amount: log.args.amount!.toString(),
            claimed: false,
          },
        }
    }
    if (move.deposit && !move.deposit.claimed) {
      const token = await destination.tokenService()
      const salts = deriveSkyEscrowSalts(unlocked.masterSecret, move.nonce)
      const escrow = move.escrow
      const claimed = await token
        .claimSweptDeposit({
          inboxIndex: BigInt(move.deposit.inboxIndex),
          amount: BigInt(move.deposit.amount),
          recipient: account.getAddress(),
          sharedSecretSalt: salts.recipient,
        })
        .then(
          () => true,
          (err: unknown) => {
            if (process.env.ZKMONEY_DEBUG)
              note(`claim for ${escrow}: ${err instanceof Error ? err.message : String(err)}`)
            return false
          },
        )
      move = { ...move, deposit: { ...move.deposit, claimed } }
    }
    if (move !== record.result) await records.put({ ...record, result: move })
    moves.push(move)
  }
  return moves
}
