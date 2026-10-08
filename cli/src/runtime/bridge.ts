/**
 * Bridging out: a burn into one of oxide's bridge escrows. The burn's tx broadcasts the release and the escrow's run;
 * the run swaps the DAI on Curve's 3pool and hands the USDC or USDT to Across, or the USDC to Circle's CCTP, which
 * delivers it on the destination chain. A deposit Across cannot fill comes back to the escrow, and only the escrow's
 * recovery account can move it from there.
 */
import { EthAddress } from "@aztec/aztec.js/addresses"
import { Fr } from "@aztec/aztec.js/fields"
import { AztecAddress } from "@aztec/stdlib/aztec-address"
import {
  DEFAULT_DECIMALS,
  L1_OPERATION_TIP_MARGIN_BPS,
  WITHDRAW_RELAYER_TIP,
} from "@obsidion/core/constants"
import { requireNonZeroL1Address, selectDeployment } from "@obsidion/core/oxide"
import {
  BroadcasterContract,
  findBalanceOfSlot,
  mappingSlot,
  nextOperationId,
  readPortalWithdrawalState,
} from "@obsidion/sdk"
import {
  WithdrawalSubsidyAbi,
  encodeEscrowRecoverERC20,
  findEscrowExecutionTx,
} from "@oxide/l1-contracts"
import {
  ACROSS_INPUT_TOKEN_DECIMALS,
  AcrossBridgeEscrowFactoryAbi,
  encodeAcrossBridgeEscrowDeploy,
  predictAcrossBridgeEscrowAddress,
  predictAcrossBridgeEscrowAddressLocally,
  type AcrossBridgeEscrowArgs,
} from "@oxide/l1-contracts/across_bridge_on_withdraw.js"
import {
  CCTPBridgeEscrowFactoryAbi,
  CctpFinality,
  encodeCctpBridgeEscrowDeploy,
  predictCctpBridgeEscrowAddress,
  predictCctpBridgeEscrowAddressLocally,
  type CctpBridgeEscrowArgs,
} from "@oxide/l1-contracts/cctp_bridge_on_withdraw.js"
import { quoteL1Operation } from "@oxide/oxide-client/l1_operation_quote.js"
import {
  fetchAcrossDepositStatus,
  fetchAcrossFees,
} from "@oxide/oxide-client/withdraw_escrows/across_api.js"
import {
  ACROSS_EVM_DESTINATIONS,
  acrossEvmDestination,
  buildAcrossBridgeOnWithdraw,
  quoteAcrossBridge,
  type AcrossBridgeRoute,
} from "@oxide/oxide-client/withdraw_escrows/across_bridge.js"
import { fetchCctpFees, fetchCctpMessages } from "@oxide/oxide-client/withdraw_escrows/cctp_api.js"
import {
  CCTP_FORWARDING_EVM_DOMAINS,
  buildCctpBridgeOnWithdraw,
  cctpEvmDestination,
  hyperCoreDestination,
  quoteCctpBridge,
  type CctpBridgeDestination,
} from "@oxide/oxide-client/withdraw_escrows/cctp_bridge.js"
import {
  checkedEscrowFunding,
  swappedAtPeg,
  type EscrowFundingArgs,
} from "@oxide/oxide-client/withdraw_escrows/escrow_withdrawal.js"
import { deriveRecoveryCommitment } from "@oxide/oxide-lib/sipa_recovery.js"
import {
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  keccak256,
  multicall3Abi,
  numberToHex,
  slice,
  type Address,
  type Hex,
} from "viem"
import {
  WithdrawalStorage,
  deriveSwapEscrowRecoverySalt,
  withdrawalAmounts,
  type WithdrawalRecord,
} from "../frontCore.ts"
import { CliError, amount as formatAmount, fail, note, shorten, when } from "../output.ts"
import type { Runtime } from "./boot.ts"
import { l1Sender, recoverEscrowTokens, recoveryAccountOf } from "./escrow.ts"
import { quoteFasterProof, type FasterProof } from "./fasterProof.ts"
import { Records, type OperationRecord } from "./records.ts"
import { activateNetwork, parseSendAmount, refuseInterrupted, sponsorOrFail } from "./send.ts"
import { noteSubscribed } from "./sponsor.ts"
import {
  currentDeployment,
  follow,
  fpcFundingCut,
  isTerminal,
  phaseLabel,
  resolveWithdrawRecipient,
  runBurn,
  screenerFor,
  tuplePortal,
  withdrawalTracker,
  type WithdrawStage,
} from "./withdraw.ts"

export const BRIDGE_KIND = "bridge"

export const BRIDGES = ["across", "cctp"] as const
export type Bridge = (typeof BRIDGES)[number]
export const BRIDGE_ASSETS = ["USDC", "USDT"] as const
export type BridgeAsset = (typeof BRIDGE_ASSETS)[number]

export const BRIDGE_NAMES: Record<Bridge, string> = { across: "Across", cctp: "CCTP" }

/** CCTP's route to a HyperCore spot account, through Circle's forwarder on HyperEVM. */
const HYPERCORE = "hyperCore"

export interface BridgeRoute {
  bridge: Bridge
  asset: BridgeAsset
  /** oxide's name for the destination, such as `base` or `opMainnet`. */
  chain: string
}

/** Every route the bridge escrows offer: Across for USDC and USDT, CCTP for USDC. */
export function bridgeRoutes(): BridgeRoute[] {
  const across = BRIDGE_ASSETS.flatMap((asset) =>
    Object.keys(ACROSS_EVM_DESTINATIONS[asset]).map((chain) => ({
      bridge: "across" as const,
      asset,
      chain,
    })),
  )
  const cctp = [...Object.keys(CCTP_FORWARDING_EVM_DOMAINS), HYPERCORE].map((chain) => ({
    bridge: "cctp" as const,
    asset: "USDC" as const,
    chain,
  }))
  return [...across, ...cctp]
}

const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "")

const CHAIN_ALIASES: Record<string, string> = {
  optimism: "opMainnet",
  op: "opMainnet",
  bsc: "bnb",
  hyperliquid: HYPERCORE,
}

/** A destination by oxide's name in any case, or by a common alias. */
export function parseChain(text: string): string {
  const key = squash(text)
  const chain =
    CHAIN_ALIASES[key] ?? bridgeRoutes().find((route) => squash(route.chain) === key)?.chain
  if (!chain)
    fail(`"${text}" is not a chain the bridges reach`, "`zkmoney bridges routes` lists them")
  return chain
}

export function parseBridge(text: string): Bridge {
  const bridge = text.trim().toLowerCase()
  if (!(BRIDGES as readonly string[]).includes(bridge))
    fail(`"${text}" is not a bridge`, `one of: ${BRIDGES.join(", ")}`)
  return bridge as Bridge
}

export function parseBridgeAsset(text: string): BridgeAsset {
  const asset = text.trim().toUpperCase()
  if (!(BRIDGE_ASSETS as readonly string[]).includes(asset))
    fail(`"${text}" is not an asset the bridges deliver`, `one of: ${BRIDGE_ASSETS.join(", ")}`)
  return asset as BridgeAsset
}

/** The routes that deliver `asset` to `chain`, through `bridge` if named. No asset means USDC where it goes, else USDT. */
export function routesTo(chain: string, asset?: BridgeAsset, bridge?: Bridge): BridgeRoute[] {
  const reaching = bridgeRoutes().filter(
    (route) => route.chain === chain && (!bridge || route.bridge === bridge),
  )
  if (!reaching.length)
    fail(
      bridge ? `${BRIDGE_NAMES[bridge]} does not reach ${chain}` : `no bridge reaches ${chain}`,
      "`zkmoney bridges routes` lists what reaches where",
    )
  const wanted = asset ?? (reaching.some((route) => route.asset === "USDC") ? "USDC" : "USDT")
  const routes = reaching.filter((route) => route.asset === wanted)
  if (!routes.length)
    fail(
      `no bridge${bridge ? ` through ${BRIDGE_NAMES[bridge]}` : ""} delivers ${wanted} to ${chain}`,
      "`zkmoney bridges routes` lists what reaches where",
    )
  return routes
}

export const routeLabel = (route: Pick<BridgeRoute, "bridge" | "asset" | "chain">) =>
  `${route.asset} to ${route.chain} through ${BRIDGE_NAMES[route.bridge]}`

type EscrowArgs = AcrossBridgeEscrowArgs | CctpBridgeEscrowArgs

/** What differs between the two escrows: their factory's field in the manifest, and their factory calls. */
const ESCROWS = {
  across: {
    field: "acrossBridgeEscrowFactory",
    predict: (factory: Address, args: EscrowArgs) =>
      predictAcrossBridgeEscrowAddressLocally(factory, args as AcrossBridgeEscrowArgs),
    predictOnChain: (rt: Runtime, factory: Address, args: EscrowArgs) =>
      predictAcrossBridgeEscrowAddress(rt.l1, factory, args as AcrossBridgeEscrowArgs),
    run: (args: EscrowArgs) => encodeAcrossBridgeEscrowDeploy(args as AcrossBridgeEscrowArgs),
    deploy: (args: EscrowArgs) =>
      encodeFunctionData({
        abi: AcrossBridgeEscrowFactoryAbi,
        functionName: "deploy",
        args: [args as AcrossBridgeEscrowArgs],
      }),
  },
  cctp: {
    field: "cctpBridgeEscrowFactory",
    predict: (factory: Address, args: EscrowArgs) =>
      predictCctpBridgeEscrowAddressLocally(factory, args as CctpBridgeEscrowArgs),
    predictOnChain: (rt: Runtime, factory: Address, args: EscrowArgs) =>
      predictCctpBridgeEscrowAddress(rt.l1, factory, args as CctpBridgeEscrowArgs),
    run: (args: EscrowArgs) => encodeCctpBridgeEscrowDeploy(args as CctpBridgeEscrowArgs),
    deploy: (args: EscrowArgs) =>
      encodeFunctionData({
        abi: CCTPBridgeEscrowFactoryAbi,
        functionName: "deploy",
        args: [args as CctpBridgeEscrowArgs],
      }),
  },
} as const

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

const manifestEntries = new WeakMap<Runtime, Promise<Record<string, unknown>>>()

/** The pinned manifest entry as published, which names the bridge factories the wallet's tuple leaves out. */
function manifestEntry(rt: Runtime): Promise<Record<string, unknown>> {
  let entry = manifestEntries.get(rt)
  if (!entry) {
    entry = (async () => {
      const response = await fetch(rt.config.oxide.manifestUrl)
      if (!response.ok) fail(`the oxide manifest answered HTTP ${response.status}`)
      return selectDeployment(await response.json(), { portal: rt.tuple.portal })
    })()
    manifestEntries.set(rt, entry)
  }
  return entry
}

const daiAbi = [
  {
    type: "function",
    name: "DAI",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
] as const

/** A bridge's escrow factory: a setting, else the manifest's, checked to escrow this deployment's DAI. */
async function bridgeFactory(rt: Runtime, bridge: Bridge): Promise<Address> {
  const { field } = ESCROWS[bridge]
  const named = rt.config.bridgeEscrowFactories[bridge]?.value ?? (await manifestEntry(rt))[field]
  if (named === undefined)
    fail(
      `the ${rt.network} manifest names no ${BRIDGE_NAMES[bridge]} escrow factory`,
      `\`zkmoney config set addresses.${field} <address>\` names one`,
    )
  const factory = requireNonZeroL1Address(named, field) as Address
  const dai = await rt.l1.readContract({ address: factory, abi: daiAbi, functionName: "DAI" })
  if (!sameAddress(dai, rt.tuple.token))
    fail(
      `the ${BRIDGE_NAMES[bridge]} escrow factory ${factory} escrows ${dai}, not this deployment's DAI`,
    )
  return factory
}

const simulationValue = (label: string) =>
  keccak256(new TextEncoder().encode(`obsidion.bridge-on-withdraw.simulation-${label}`))
/** Sends the simulated run as the relayer does, from an EOA the run never touches. */
const SIMULATION_SENDER = slice(simulationValue("sender"), 12) as Address
/** The run never opens the recovery commitment; it only has to be nonzero. */
const SIMULATION_RECOVERY = simulationValue("recovery")
const SIMULATION_NONCE = simulationValue("nonce")
/** Gas depends on whether the tip transfer writes a nonzero balance, not on the amount, so 1 wei prices any tip. */
const SIMULATION_TIP = 1n

/**
 * The DAI tip that gets an escrow run: oxide's relayer quote for the run, simulated with the escrow holding its
 * funding by state override, plus the wallet's margin.
 */
async function quoteRunTip(
  rt: Runtime,
  run: { factory: Address; calldata: Hex; escrow: Address; funding: bigint },
): Promise<bigint> {
  const dai = rt.tuple.token as Address
  const [balanceOfSlot, ethUsdFeed] = await Promise.all([
    findBalanceOfSlot(rt.l1 as never, dai),
    rt.l1.readContract({
      address: tuplePortal(rt.tuple, "withdrawalSubsidy"),
      abi: WithdrawalSubsidyAbi,
      functionName: "PRICE_FEED",
    }),
  ])
  const quote = await quoteL1Operation(rt.l1 as never, {
    executor: tuplePortal(rt.tuple, "operationExecutor"),
    sender: SIMULATION_SENDER,
    ethUsdFeed: ethUsdFeed as Address,
    payout: SIMULATION_TIP,
    operation: { target: run.factory, calldata: run.calldata, payoutToken: dai },
    stateOverrides: [
      {
        address: dai,
        stateDiff: [
          {
            slot: mappingSlot(run.escrow, balanceOfSlot),
            value: numberToHex(run.funding, { size: 32 }),
          },
        ],
      },
    ],
  })
  return (quote.minPayout * L1_OPERATION_TIP_MARGIN_BPS + 9_999n) / 10_000n
}

/** Circle attests a fast transfer in seconds rather than after Ethereum's finality. */
const CCTP_FINALITY = CctpFinality.Fast

export interface BridgeQuote {
  route: BridgeRoute
  factory: Address
  /** DAI the escrow pays whoever runs it. */
  escrowTip: bigint
  /** Across's fee in its input token, or the most Circle takes in USDC: 6 decimals either way. */
  bridgeFee: bigint
  /** What arrives, in the delivered token's units: at a 1:1 swap, and at the swap's floor. */
  expected: bigint
  minReceived: bigint
  decimals: number
  across?: AcrossBridgeRoute
  cctp?: CctpBridgeDestination
}

interface BurnFunding {
  amount: bigint
  proverTip: bigint
  fpcFundingCut: bigint
  recipient: Address
}

/** One route's quote. The run's gas does not depend on the bridge fee, so the fee quoted before the tip prices it. */
async function quoteRoute(
  rt: Runtime,
  route: BridgeRoute,
  burn: BurnFunding,
): Promise<BridgeQuote> {
  const factory = await bridgeFactory(rt, route.bridge)
  const funding: EscrowFundingArgs = {
    amount: burn.amount,
    withdrawalRelayerTip: WITHDRAW_RELAYER_TIP,
    proverTip: burn.proverTip,
    fpcFundingCut: burn.fpcFundingCut,
    relayerTip: 0n,
  }
  const escrowFunding = checkedEscrowFunding(funding)
  const runTip = (args: EscrowArgs) =>
    quoteRunTip(rt, {
      factory,
      calldata: ESCROWS[route.bridge].run(args),
      escrow: ESCROWS[route.bridge].predict(factory, args),
      funding: escrowFunding,
    })
  const simulated = {
    recipient: burn.recipient,
    recoveryCommitment: SIMULATION_RECOVERY,
    relayerTip: SIMULATION_TIP,
    nonce: SIMULATION_NONCE,
  }
  const common = { route, factory }
  if (route.bridge === "across") {
    const across = acrossEvmDestination(route.asset, route.chain as never)
    const fees = await fetchAcrossFees({ ...funding, route: across })
    const escrowTip = await runTip({
      ...simulated,
      acrossInputToken: across.acrossInputToken.toString() as Address,
      destinationChainId: across.destinationChainId,
      acrossOutputToken: across.acrossOutputToken.toString() as Address,
      acrossOutputTokenDecimals: across.acrossOutputTokenDecimals,
      acrossFee: quoteAcrossBridge({ ...funding, route: across }, fees).acrossFee,
    })
    const priced = { ...funding, relayerTip: escrowTip, route: across }
    const { acrossFee, minReceived } = quoteAcrossBridge(priced, fees)
    const scale = 10n ** BigInt(across.acrossOutputTokenDecimals - ACROSS_INPUT_TOKEN_DECIMALS)
    return {
      ...common,
      escrowTip,
      bridgeFee: acrossFee,
      expected: (swappedAtPeg(priced) - acrossFee) * scale,
      minReceived,
      decimals: across.acrossOutputTokenDecimals,
      across,
    }
  }
  const cctp =
    route.chain === HYPERCORE
      ? await hyperCoreDestination(EthAddress.fromString(burn.recipient))
      : cctpEvmDestination(route.chain as never)
  const fees = await fetchCctpFees(cctp)
  const finality = { destination: cctp, minFinalityThreshold: CCTP_FINALITY }
  const escrowTip = await runTip({
    ...simulated,
    route: cctp.route,
    destinationDomain: cctp.domain,
    minFinalityThreshold: CCTP_FINALITY,
    maxFee: quoteCctpBridge({ ...funding, ...finality }, fees).maxFee,
  })
  const priced = { ...funding, ...finality, relayerTip: escrowTip }
  const { maxFee, minReceived } = quoteCctpBridge(priced, fees)
  return {
    ...common,
    escrowTip,
    bridgeFee: maxFee,
    expected: swappedAtPeg(priced) - maxFee - cctp.deliveryFee,
    minReceived,
    decimals: 6,
    cctp,
  }
}

const atWad = (quote: BridgeQuote) => quote.minReceived * 10n ** BigInt(18 - quote.decimals)

/** Quotes each route and keeps the one that delivers the most at the swap's floor. */
export async function quoteBridge(
  rt: Runtime,
  routes: BridgeRoute[],
  burn: BurnFunding,
): Promise<BridgeQuote> {
  const settled = await Promise.allSettled(routes.map((route) => quoteRoute(rt, route, burn)))
  const quotes = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []))
  if (!quotes.length) {
    const reasons = settled.map((s) => (s.status === "rejected" ? s.reason : undefined))
    if (process.env.ZKMONEY_DEBUG)
      for (const reason of reasons) note(String(reason?.stack ?? reason))
    const hints = new Set(reasons.flatMap((r) => (r instanceof CliError && r.hint ? [r.hint] : [])))
    fail(
      reasons
        .map((reason, i) => {
          const message = reason instanceof Error ? reason.message : String(reason)
          return `${routeLabel(routes[i]!)}: ${message.split("\n")[0]}`
        })
        .join("; "),
      hints.size ? [...hints].join("; ") : "`zkmoney bridges routes` lists the other routes",
    )
  }
  return quotes.reduce((best, quote) => (atWad(quote) > atWad(best) ? quote : best))
}

/** Across's or Circle's latest word on the delivery. */
export type BridgeDelivery =
  /** `delay` is Circle's reason for holding a transfer back. */
  | { state: "pending"; delay?: string }
  /** Across asked its spoke pool to fill it, which waits for a root bundle. */
  | { state: "slow" }
  | { state: "arrived"; txHash: Hex }
  /** Across did not fill it before its deadline; the refund to the escrow comes next. */
  | { state: "expired" }
  | { state: "refunded"; txHash: Hex }
  | { state: "failed"; reason: string }

export interface BridgeTransfer {
  bridge: Bridge
  asset: BridgeAsset
  chain: string
  recipient: Address
  recipientAlias?: string
  /** DAI burned, fees included. */
  amount: string
  withdrawalLocalId: string
  factory: Address
  escrow: Address
  /** What the escrow address commits to, bigints as decimal strings: they rebuild its run and its recovery. */
  escrowArgs: Record<string, string | number>
  escrowTip: string
  proverTip?: string
  bridgeFee: string
  expected: string
  minReceived: string
  decimals: number
  /** L1 block before the burn: the escrow runs after it. */
  scanFrom: string
  /** The L1 tx that ran the escrow, which is the bridge's deposit or burn. */
  runTxHash?: Hex
  delivery?: BridgeDelivery
  recovered?: { to: Address; txHashes: Hex[] }
}

const BIGINT_ARGS = new Set(["destinationChainId", "acrossFee", "maxFee", "relayerTip"])

export const storedArgs = (args: EscrowArgs): Record<string, string | number> =>
  Object.fromEntries(
    Object.entries(args).map(([key, value]) => [
      key,
      typeof value === "bigint" ? value.toString() : value,
    ]),
  )

export const escrowArgsOf = (transfer: Pick<BridgeTransfer, "escrowArgs">): EscrowArgs =>
  Object.fromEntries(
    Object.entries(transfer.escrowArgs).map(([key, value]) => [
      key,
      BIGINT_ARGS.has(key) ? BigInt(value) : value,
    ]),
  ) as unknown as EscrowArgs

export const newBridgeId = () =>
  `br-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

export interface BridgeInput {
  amount: string
  to: string
  chain: string
  asset?: string
  via?: string
  key?: string
  /** Pay a DAI prover tip for an early proof. */
  faster?: boolean
}

export async function bridge(
  rt: Runtime,
  input: BridgeInput,
  onStage: (stage: WithdrawStage) => void,
): Promise<{ id: string; transfer: BridgeTransfer; replayed: boolean; faster?: FasterProof }> {
  const id = input.key ?? newBridgeId()
  const records = new Records(rt.storage)
  await refuseInterrupted(
    records,
    BRIDGE_KIND,
    id,
    "check `zkmoney bridges list` for the earlier burn, then use a new key",
  )
  const chain = parseChain(input.chain)
  const via = input.via ? parseBridge(input.via) : undefined
  const routes = routesTo(chain, input.asset ? parseBridgeAsset(input.asset) : undefined, via)
  onStage("building")
  await activateNetwork(rt)
  const tokenService = await rt.tokenService()
  const token = await tokenService.fetchTokenInformation()
  const amount = parseSendAmount(input.amount, token.decimals)
  const recipient = await resolveWithdrawRecipient(rt, input.to)
  const args = {
    to: recipient.address,
    chain,
    asset: routes[0]!.asset,
    via: via ?? null,
    amount: amount.atomic.toString(),
  }
  const known = await records.get<BridgeTransfer>(BRIDGE_KIND, id)
  if (known?.result) {
    const done = known.result
    const replay = await records.once(BRIDGE_KIND, id, args, async () => done)
    return { id, transfer: replay.result, replayed: replay.replayed }
  }
  const { unlocked, account } = await rt.account()
  // Screened before any record exists; a screener that cannot answer blocks.
  const verdict = await screenerFor(rt)
    .screen(recipient.address)
    .catch((err: unknown) =>
      fail(
        `the recipient could not be screened: ${err instanceof Error ? err.message : String(err)}`,
        "try again",
      ),
    )
  if (!verdict.compliant) fail(verdict.reason?.message ?? "this address cannot receive withdrawals")
  const faster = input.faster ? await quoteFasterProof(rt) : undefined
  const proverTip = faster?.proverTip ?? 0n
  const cut = await fpcFundingCut(rt)
  if (amount.atomic <= WITHDRAW_RELAYER_TIP + cut + proverTip)
    fail(
      `the amount does not cover the withdrawal fee of ${formatAmount(
        WITHDRAW_RELAYER_TIP + cut + proverTip,
        token.decimals,
        token.symbol,
      )}`,
    )
  const quote = await quoteBridge(rt, routes, {
    amount: amount.atomic,
    proverTip,
    fpcFundingCut: cut,
    recipient: recipient.address,
  })
  const balance = await tokenService.getBalance()
  if (balance < amount.atomic)
    fail(
      `the balance is ${formatAmount(balance, token.decimals, token.symbol)}, below ${formatAmount(
        amount.atomic,
        token.decimals,
        token.symbol,
      )}`,
    )
  const handle = await records.once<BridgeTransfer>(BRIDGE_KIND, id, args, async () => {
    const sponsor = await sponsorOrFail(rt, unlocked.file.identity?.tag)
    const nonce = Fr.random().toString() as Hex
    const broadcaster = tuplePortal(rt.tuple, "l2Broadcaster")
    const escrow = {
      broadcaster: BroadcasterContract.at(
        AztecAddress.fromStringUnsafe(broadcaster),
        await rt.broadcasterArtifact(broadcaster),
        rt.wallet as never,
      ),
      dai: EthAddress.fromString(rt.tuple.token),
      from: account.getAddress(),
      plainWithdrawalExecutor: EthAddress.fromString(
        tuplePortal(rt.tuple, "plainWithdrawalExecutor"),
      ),
      amount: amount.atomic,
      withdrawalRelayerTip: WITHDRAW_RELAYER_TIP,
      proverTip,
      fpcFundingCut: cut,
      recoveryAccount: EthAddress.fromString(await recoveryAccountOf(rt)),
      relayerTip: quote.escrowTip,
      nonce,
      recoverySalt: deriveSwapEscrowRecoverySalt(unlocked.masterSecret, nonce),
      recipient: EthAddress.fromString(recipient.address),
    }
    const factory = EthAddress.fromString(quote.factory)
    const built = quote.across
      ? buildAcrossBridgeOnWithdraw({
          ...escrow,
          acrossBridgeEscrowFactory: factory,
          route: quote.across,
          acrossFee: quote.bridgeFee,
        })
      : buildCctpBridgeOnWithdraw({
          ...escrow,
          cctpBridgeEscrowFactory: factory,
          destination: quote.cctp!,
          minFinalityThreshold: CCTP_FINALITY,
          maxFee: quote.bridgeFee,
        })
    if (built.operation.kind !== "withdraw") fail("the bridge escrow built no withdrawal")
    // A factory with another args layout could never deploy this escrow, and the burned DAI would be lost.
    const predicted = await ESCROWS[quote.route.bridge].predictOnChain(
      rt,
      quote.factory,
      built.escrowArgs,
    )
    if (!sameAddress(predicted, built.escrow.toString()))
      fail(`the ${BRIDGE_NAMES[quote.route.bridge]} escrow factory predicts another escrow`)
    const userPayload = built.operation.userPayload
    const scanFrom = (await rt.l1.getBlockNumber()).toString()
    const portal = await readPortalWithdrawalState(rt.l1 as never, rt.tuple.portal as Address)
    const operationId = nextOperationId("withdraw")
    const { record, mined } = await runBurn(rt, {
      operationId,
      record: {
        recipient: built.escrow.toString(),
        recipientProvenance: "saved-recipient",
        amount: formatUnits(amount.atomic, token.decimals),
        rawAmount: amount.atomic.toString(),
        relayerTip: WITHDRAW_RELAYER_TIP.toString(),
        proverTip: proverTip.toString(),
        fpcFundingCut: cut.toString(),
        tokenSymbol: token.symbol,
        phase: "submitting",
        startTime: Date.now(),
        deployment: currentDeployment(rt),
      },
      burn: () => {
        onStage("proving")
        return tokenService.exitToL1PrivateSponsored(
          built.escrow,
          amount.atomic.toString(),
          sponsor,
          {
            operationId,
            userAccount: account,
            useRawAmount: true,
            proverTip,
            withdrawal: {
              tuple: rt.tuple,
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
      ...quote.route,
      recipient: recipient.address,
      ...(recipient.alias ? { recipientAlias: recipient.alias } : {}),
      amount: amount.atomic.toString(),
      withdrawalLocalId: record.localId,
      factory: quote.factory,
      escrow: built.escrow.toString() as Address,
      escrowArgs: storedArgs(built.escrowArgs),
      escrowTip: quote.escrowTip.toString(),
      ...(proverTip ? { proverTip: proverTip.toString() } : {}),
      bridgeFee: quote.bridgeFee.toString(),
      expected: quote.expected.toString(),
      minReceived: quote.minReceived.toString(),
      decimals: quote.decimals,
      scanFrom,
    }
  })
  return { id, transfer: handle.result, replayed: handle.replayed, faster }
}

async function readDelivery(transfer: BridgeTransfer, runTxHash: Hex): Promise<BridgeDelivery> {
  if (transfer.bridge === "across") {
    const status = await fetchAcrossDepositStatus(runTxHash)
    switch (status?.status) {
      case "filled":
        return { state: "arrived", txHash: status.fillTxHash }
      case "refunded":
        return { state: "refunded", txHash: status.refundTxHash }
      case "expired":
        return { state: "expired" }
      case "slowFillRequested":
        return { state: "slow" }
      default:
        return { state: "pending" }
    }
  }
  const [message] = (await fetchCctpMessages(runTxHash)) ?? []
  if (message?.forwardState === "COMPLETE" && message.forwardTxHash)
    return { state: "arrived", txHash: message.forwardTxHash }
  if (message?.forwardState === "FAILED")
    return { state: "failed", reason: message.forwardErrorCode ?? "forwarding failed" }
  return message?.delayReason
    ? { state: "pending", delay: message.delayReason }
    : { state: "pending" }
}

/** Nothing more happens to it without the user. */
const isSettled = (transfer: BridgeTransfer) =>
  !!transfer.recovered || ["arrived", "refunded", "failed"].includes(transfer.delivery?.state ?? "")

/** Finds the escrow's run once the burn is released, then asks the bridge how the delivery is going. */
export async function settleTransfer(
  rt: Runtime,
  transfer: BridgeTransfer,
  record: WithdrawalRecord | undefined,
): Promise<BridgeTransfer> {
  if (isSettled(transfer)) return transfer
  let runTxHash = transfer.runTxHash
  if (!runTxHash) {
    if (record?.phase !== "done") return transfer
    runTxHash = await findEscrowExecutionTx(
      rt.l1,
      transfer.factory,
      transfer.escrow,
      BigInt(transfer.scanFrom),
    )
    if (!runTxHash) return transfer
  }
  // A bridge API that does not answer leaves the last word in place.
  const delivery = await readDelivery(transfer, runTxHash).catch(() => transfer.delivery)
  return { ...transfer, runTxHash, ...(delivery ? { delivery } : {}) }
}

export interface BridgeView {
  id: string
  transfer: BridgeTransfer
  record?: WithdrawalRecord
}

type StoredTransfer = OperationRecord<BridgeTransfer> & { result: BridgeTransfer }

/** The withdrawal store, after one pass of the tracker when `sync` is set and a burn is still in flight. */
async function withdrawals(rt: Runtime, transfers: BridgeTransfer[], sync: boolean) {
  const store = WithdrawalStorage.get(rt.storage)
  await store.load()
  const inFlight = transfers.some((transfer) => {
    const record = store.get(transfer.withdrawalLocalId)
    return record && !isTerminal(record)
  })
  if (sync && inFlight) await (await withdrawalTracker(rt)).syncOnce()
  return store
}

async function settleView(
  rt: Runtime,
  records: Records,
  stored: StoredTransfer,
  store: Awaited<ReturnType<typeof withdrawals>>,
): Promise<BridgeView> {
  const record = store.get(stored.result.withdrawalLocalId) ?? undefined
  const transfer = await settleTransfer(rt, stored.result, record)
  if (JSON.stringify(transfer) !== JSON.stringify(stored.result))
    await records.put({ ...stored, result: transfer })
  return { id: stored.key, transfer, record }
}

/** One transfer, settled as far as the chain and the bridge allow, and saved. */
export async function bridgeView(
  rt: Runtime,
  id: string,
  opts: { sync?: boolean } = {},
): Promise<BridgeView | undefined> {
  const records = new Records(rt.storage)
  const stored = await records.get<BridgeTransfer>(BRIDGE_KIND, id)
  if (!stored?.result) return undefined
  const store = await withdrawals(rt, [stored.result], opts.sync ?? true)
  return settleView(rt, records, stored as StoredTransfer, store)
}

/** Every transfer, newest first, each settled and saved. */
export async function listBridges(rt: Runtime): Promise<BridgeView[]> {
  const records = new Records(rt.storage)
  const stored = (await records.list<BridgeTransfer>(BRIDGE_KIND)).filter(
    (record): record is StoredTransfer => !!record.result,
  )
  const store = await withdrawals(
    rt,
    stored.map((record) => record.result),
    true,
  )
  const views: BridgeView[] = []
  for (const record of stored) views.push(await settleView(rt, records, record, store))
  return views
}

/** The relayer runs an escrow minutes after its release; this long without a run is late. */
const RUN_EXPECTED_MS = 30 * 60 * 1000

export interface BridgeState {
  label: string
  /** Nothing more happens to it without the user. */
  settled: boolean
}

export function bridgeState(view: BridgeView, now = Date.now()): BridgeState {
  const { transfer, record } = view
  if (transfer.recovered)
    return { label: `recovered to ${shorten(transfer.recovered.to)}`, settled: true }
  const delivery = transfer.delivery
  switch (delivery?.state) {
    case "arrived":
      return { label: `arrived on ${transfer.chain}`, settled: true }
    case "failed":
      return { label: `Circle could not deliver it: ${delivery.reason}`, settled: true }
    case "refunded":
      return {
        label: `Across refunded it to the escrow; \`zkmoney bridges recover ${view.id} --to <address>\` takes it out`,
        settled: true,
      }
    case "expired":
      return { label: "Across did not fill it in time; it refunds the escrow next", settled: false }
    case "slow":
      return { label: `Across is filling it slowly on ${transfer.chain}`, settled: false }
  }
  if (transfer.runTxHash)
    return {
      label:
        transfer.bridge === "across"
          ? `Across is filling it on ${transfer.chain}`
          : `Circle is delivering it to ${transfer.chain}${
              delivery?.state === "pending" && delivery.delay
                ? ` (held back: ${delivery.delay})`
                : ""
            }`,
      settled: false,
    }
  if (!record) return { label: "burn not recorded", settled: true }
  if (record.phase === "failed")
    return { label: `the burn failed${record.error ? `: ${record.error}` : ""}`, settled: true }
  if (!isTerminal(record)) return { label: phaseLabel(record, now), settled: false }
  const late = now - (record.endTime ?? record.startTime) > RUN_EXPECTED_MS
  return {
    label: `waiting for the relayer to run the bridge${
      late
        ? ` (taking longer than usual; \`zkmoney bridges recover ${view.id}\` runs it yourself)`
        : ""
    }`,
    settled: false,
  }
}

/** The lines `bridge` and `bridges get` print for one transfer. */
export function bridgeSummary(
  view: BridgeView,
  opts: { full?: boolean; now?: number } = {},
): [string, string | undefined][] {
  const { transfer, record } = view
  const short = (value: string | undefined) => (value ? shorten(value, opts.full) : undefined)
  const to = transfer.recipientAlias
    ? `${transfer.recipientAlias} (${short(transfer.recipient)})`
    : short(transfer.recipient)
  const delivered = (atomic: string) =>
    formatAmount(BigInt(atomic), transfer.decimals, transfer.asset)
  const daiFees =
    record?.relayerTip !== undefined
      ? withdrawalAmounts(record).feeAtomic + BigInt(transfer.escrowTip)
      : undefined
  const bridgeFee = `${transfer.bridge === "cctp" ? "up to " : ""}${formatAmount(
    BigInt(transfer.bridgeFee),
    6,
    transfer.asset,
  )} to ${BRIDGE_NAMES[transfer.bridge]}`
  const delivery = transfer.delivery
  return [
    ["State", bridgeState(view, opts.now).label],
    ["Route", routeLabel(transfer)],
    ["Amount", formatAmount(BigInt(transfer.amount), DEFAULT_DECIMALS, "DAI")],
    [
      "Fees",
      daiFees === undefined
        ? bridgeFee
        : `${formatAmount(daiFees, DEFAULT_DECIMALS, "DAI")}, then ${bridgeFee}`,
    ],
    [
      "Receives",
      `about ${delivered(transfer.expected)}, at least ${delivered(transfer.minReceived)}`,
    ],
    ["To", `${to} on ${transfer.chain}`],
    ["Escrow", short(transfer.escrow)],
    ["L2 tx", short(record?.l2TxHash)],
    ["Release tx", short(record?.l1TxHash)],
    ["Bridge tx", short(transfer.runTxHash)],
    ["Arrival tx", short(delivery?.state === "arrived" ? delivery.txHash : undefined)],
    ["Refund tx", short(delivery?.state === "refunded" ? delivery.txHash : undefined)],
    ["Recovery", transfer.recovered?.txHashes.map((hash) => short(hash)).join(", ")],
    ["Started", record ? when(record.startTime) : undefined],
  ]
}

/** Follows a transfer until nothing more happens to it without the user, reporting each change. */
export async function waitForBridge(
  rt: Runtime,
  id: string,
  onChange: (view: BridgeView) => void,
  intervalMs = 20_000,
): Promise<BridgeView> {
  const tracker = await withdrawalTracker(rt)
  tracker.stop()
  return follow(
    async () => {
      const view = await bridgeView(rt, id)
      if (!view) fail(`no bridge "${id}"`)
      return view
    },
    {
      key: (view) =>
        [bridgeState(view).label, view.record?.l1TxHash, view.transfer.runTxHash].join("|"),
      done: (view) => bridgeState(view).settled,
      onChange,
      intervalMs,
    },
  )
}

/**
 * The exits from an escrow holding funds, sent from `privateKey`, which pays the gas. Without `to`, run the escrow
 * nobody ran, which pays the sender its tip. With `to`, send what it holds there instead, signed by this account's
 * OxideAccount: the only way back for an Across refund.
 */
export async function recoverBridge(
  rt: Runtime,
  input: { id: string; to?: Address },
  privateKey: Hex,
): Promise<{ txHashes: Hex[] }> {
  const records = new Records(rt.storage)
  const stored = await records.get<BridgeTransfer>(BRIDGE_KIND, input.id)
  const transfer = stored?.result
  if (!stored || !transfer) fail(`no bridge "${input.id}"`, "`zkmoney bridges list` shows them")
  if (transfer.recovered)
    fail(`this bridge's escrow was already recovered to ${transfer.recovered.to}`)
  if (transfer.delivery?.state === "arrived") fail("this bridge already delivered")
  const { unlocked } = await rt.account()
  const args = escrowArgsOf(transfer)
  const recovery = {
    account: await recoveryAccountOf(rt),
    salt: deriveSwapEscrowRecoverySalt(unlocked.masterSecret, args.nonce),
  }
  const commitment = deriveRecoveryCommitment(
    recovery.salt,
    EthAddress.fromString(recovery.account),
  )
  if (
    commitment.toString() !== args.recoveryCommitment ||
    !sameAddress(ESCROWS[transfer.bridge].predict(transfer.factory, args), transfer.escrow)
  )
    fail(`this account's keys do not rebuild escrow ${transfer.escrow}`)
  const dai = rt.tuple.token as Address
  const tokens = "acrossInputToken" in args ? [dai, args.acrossInputToken as Address] : [dai]
  const holdings = await Promise.all(
    tokens.map(
      async (token) =>
        [
          token,
          await rt.l1.readContract({
            address: token,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [transfer.escrow],
          }),
        ] as const,
    ),
  )
  if (holdings.every(([, held]) => held === 0n))
    fail(
      "the escrow holds nothing",
      "`zkmoney bridges get` shows whether its burn is released or its bridge already ran",
    )
  const send = l1Sender(rt, privateKey)
  if (!input.to) {
    if (holdings[0]![1] <= args.relayerTip)
      fail(
        "the escrow holds no more DAI than its tip, so running it would move nothing",
        "send what it holds to an Ethereum address with --to",
      )
    return {
      txHashes: [await send({ to: transfer.factory, data: ESCROWS[transfer.bridge].run(args) })],
    }
  }
  const to = input.to
  const txHashes = await recoverEscrowTokens(
    rt,
    { escrow: transfer.escrow, account: recovery.account, to, holdings },
    (signed) => {
      const recover = encodeEscrowRecoverERC20({
        recoverySalt: recovery.salt.toString() as Hex,
        account: recovery.account,
        signature: signed.signature,
        target: to,
        token: signed.token,
        nonce: signed.nonce,
        deadline: signed.deadline,
      })
      if (signed.deployed) return { to: transfer.escrow, data: recover }
      const multicall3 = rt.l1Chain.contracts?.multicall3?.address
      if (!multicall3) fail(`no Multicall3 is known on chain ${rt.l1Chain.id} to deploy the escrow`)
      // An escrow that never ran has no code: the factory deploys it in the same transaction.
      const calls = [
        {
          target: transfer.factory,
          allowFailure: false,
          callData: ESCROWS[transfer.bridge].deploy(args),
        },
        { target: transfer.escrow, allowFailure: false, callData: recover },
      ]
      return {
        to: multicall3,
        data: encodeFunctionData({ abi: multicall3Abi, functionName: "aggregate3", args: [calls] }),
      }
    },
    send,
  )
  await records.put({ ...stored, result: { ...transfer, recovered: { to, txHashes } } })
  return { txHashes }
}
