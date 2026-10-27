// The boundary to a source generation: wallet code built for another Aztec release, loaded beside
// the app. Only plain data crosses it, so this file imports nothing at runtime. The generation's
// build compiles it against that release's own `@obsidion/core/types`.
import type { FrozenDepositDescriptor, FrozenRefundKind, OxideEnvTuple } from "@obsidion/core/types"

/** The version of this boundary. Change it on any change a built bundle cannot serve. */
export const SOURCE_GENERATION_PROTOCOL = 8

/** The account's passkey. The page signs, so a generation never touches WebAuthn itself. */
export interface SourcePasskey {
  /** P-256 public key coordinates, 32-byte hex each. */
  publicKey: { x: string; y: string }
  sign(challenge: Uint8Array): Promise<{
    authenticatorData: Uint8Array
    clientDataJSON: Uint8Array
    signature: Uint8Array
  }>
}

export interface SourceAccountKeys {
  /** The account's master secret, Fr hex. */
  secretKey: string
  passkey: SourcePasskey
}

/** A profile version's reviewed artifact manifest, as `createArtifactCatalog` locates it. */
export interface SourceArtifactManifest {
  profileUrl: string
  profileId: string
  versionId: string
  /** The manifest's sha256. Without it the version names no reviewed classes. */
  expectedSha256?: string
}

export interface SourceGenerationOpenParams {
  account: SourceAccountKeys
  /** A node of the source rollup. */
  nodeUrl: string
  /** Key the node's API gateway requires, when it has one. */
  nodeApiKey?: string
  l1RpcUrl: string
  l1ChainId: number
  network: string
  /** The source profile version's `ContractServiceConfig`. */
  contracts: unknown
  /**
   * The source profile version's artifact manifest: every class its contracts have had, with each
   * class's artifact. A payment link's escrow keeps the class it was created under.
   */
  artifacts?: SourceArtifactManifest
  proverEnabled: boolean
}

export interface SourceRefundCandidates {
  maxNotesPerBatch: number
  /** Decimal. */
  maxBatchAmount: string
  /** Decimal: what deposits the portal can't refund yet hold. */
  waiting?: string
  candidates: {
    id: string
    amount: string
    kind: FrozenRefundKind
    /** The payment link escrow an `escrow-note` belongs to. */
    owner?: string
    /** A deposit's Inbox leaf index. */
    leafIndex?: string
  }[]
}

/**
 * The account's payment link rows on the source deployment, as this browser stores them. The
 * generation rebuilds a link no funding transfer announces from its row.
 */
export type SourcePaylinkRows = () => Promise<unknown[]>

/** An L1 operation the destination broadcasts. Only an immediate condition crosses. */
export interface SourceL1Operation {
  target: string
  payoutToken: string
  /** Hex. */
  calldata: string
}

/**
 * The executor a refund names and the payloads that executor runs. All hex. The refund proof binds
 * the executor and the sha256 of the user payload.
 */
export interface SourceExecutorCall {
  executor: string
  userPayload: string
  relayerPayload: string
}

/**
 * `FrozenMigrationRuntime` in plain data. The host selects the executor call of each refund: the
 * source's plain withdrawal executor, or a migration executor that the destination deploys.
 */
export interface SourceRefundRuntime {
  identity: string
  validate(destinationAsset: string): Promise<void>
  candidates(opts?: { fresh?: boolean }): Promise<SourceRefundCandidates>
  /**
   * The call of the source's plain withdrawal executor, in the encoding that executor reads. It pays
   * `relayerTip` to the session's tip recipient and the remainder to `recipient`.
   */
  plainExecutorCall(
    recipient: string,
    /** Decimal. */
    relayerTip: string,
  ): Promise<SourceExecutorCall>
  /**
   * Proves the refund of `selection` to `executorCall`. The generation does not read the payloads,
   * so the host checks that the amount covers the tip.
   */
  build(
    selection: { kind: FrozenRefundKind; ids: string[] },
    executorCall: SourceExecutorCall,
  ): Promise<{ amount: string; operation: SourceL1Operation }>
  refunded(ids: string[]): Promise<boolean>
}

/** A verified Savings withdrawal memo, with plain fields across Aztec generations. */
export interface SourceSavingsMove {
  direction: "in" | "out"
  factory: string
  nonce: string
  recipientCommitment: string
}

/** The SIPAs of one source deployment: what finding them, and their deposits, needs. */
export interface SourceSipaScan {
  tuple: OxideEnvTuple
  /** Historical resolver senders selected for this deployment. */
  resolverL2Addresses: string[]
  /** The account's stealth public key, decimal coordinates. */
  stealthPublicKey: { x: string; y: string }
  /** The owner's L1 account, which an account-protocol deployment's SIPAs commit to. */
  recoveryAccount?: string
}

/** The account on one source rollup, read through a PXE of the source release. */
export interface SourceGenerationSession {
  /** The account's L2 address on the source rollup. */
  readonly address: string
  /** The source rollup's L1 address: the network id its records carry. */
  readonly rollupAddress: string
  /** The account's private balance on a live source deployment's token, decimal. */
  balance(o: { tuple: OxideEnvTuple }): Promise<string>
  /**
   * The SIPAs the source deployment sent this account, with their addresses. Only the source
   * generation knows how its SIPA addresses are formed.
   */
  sipaSources(o: SourceSipaScan): Promise<
    {
      sipaAddress: string
      recipientL2Address: string
      messageSecret: string
      /** What the SIPA's sweeps deposit to on the portal, Fr hex. */
      recipientCommitment: string
    }[]
  >
  /**
   * The account's history on the source deployment, as the source wallet's own sync files it into
   * a store of its own: the entries a source browser's database holds for the account. A sync that
   * reads short rejects.
   */
  history(
    o: SourceSipaScan & {
      /** The account's display tag, which its own rows name it by. */
      accountTag: string
      /** A link row's share URL is this plus the link's inline form. */
      linkBase: string
      /** The source rollup's deployments: a Savings move settles on the one its factory names. */
      deployments?: OxideEnvTuple[]
    },
  ): Promise<Record<string, string>>
  /** Savings moves recovered from this account's withdrawals on the source token. */
  savingsMoves(o: { tuple: OxideEnvTuple }): Promise<SourceSavingsMove[]>
  /** What a frozen portal can still refund, or `undefined` while it is live. Amounts decimal. */
  frozenSummary(o: {
    tuple: OxideEnvTuple
    depositDescriptors: () => Promise<FrozenDepositDescriptor[]>
    paylinkRows: SourcePaylinkRows
  }): Promise<
    | {
        notes: string
        /** What the account's open payment links hold. */
        links: string
        deposits: number
        waiting: number
        waitingAmount: string
      }
    | undefined
  >
  /**
   * The funding tx hashes of the open links among `paylinkRows` that a frozen refund paid out on L1.
   * Empty while the portal is live.
   */
  refundedLinks(o: { tuple: OxideEnvTuple; paylinkRows: SourcePaylinkRows }): Promise<string[]>
  refundRuntime(o: {
    tuple: OxideEnvTuple
    /** Paid the relayer tip: the destination's operation executor. */
    tipRecipient: string
    depositDescriptors(opts: { fresh: boolean }): Promise<FrozenDepositDescriptor[]>
    paylinkRows: SourcePaylinkRows
  }): Promise<SourceRefundRuntime>
}

/** What a generation bundle's entry module exports. */
export interface SourceGenerationModule {
  /** The {@link SOURCE_GENERATION_PROTOCOL} the bundle was built against. */
  readonly protocol: number
  /** The Aztec release the bundle is built for. */
  readonly aztecVersion: string
  /** The account's L2 address on this generation's rollups. Needs no node. */
  accountAddress(
    o: {
      /** Fr hex. */
      secretKey: string
      /** The passkey public key, in the hex form `ObsidionWallet.deriveAccountAddress` takes. */
      publicKeyHex: string
    } & Pick<SourceGenerationOpenParams, "network" | "contracts">,
  ): Promise<string>
  /** One session per node for the page's lifetime. */
  open(params: SourceGenerationOpenParams): Promise<SourceGenerationSession>
}
