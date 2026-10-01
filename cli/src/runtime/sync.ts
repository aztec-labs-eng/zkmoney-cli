/**
 * The wallet's chain view for the CLI: front-core's `WalletSyncCoordinator` over the file store,
 * which scans the account's own Transfer events, writes verified history rows and the balance at
 * each synced anchor. `balance` and `txs` take one tick; `watch` keeps it running.
 */
import {
  BalanceStorage,
  ContactStorage,
  TransactionStorage,
  WalletSyncCoordinator,
  WithdrawalStorage,
  balanceScope,
  createTagForwardResolver,
  resolveTagViaRegistry,
  setActiveNetworkId,
  type Contact,
  type ContactsByL2,
  type RegistryTagResolutionOpts,
  type Transaction,
} from "../frontCore.ts"
import { createWalletSyncSource } from "@obsidion/sdk"
import type { Runtime } from "./boot.ts"

export function registryOpts(rt: Runtime): RegistryTagResolutionOpts {
  return {
    publicClient: rt.l1,
    manifestUrl: rt.config.oxide.manifestUrl,
    portal: rt.config.addressOverrides.portal ?? rt.config.oxide.portal,
    network: rt.network,
    expectedGitSha: rt.config.oxide.expectedGitSha,
    tuple: rt.tuple,
  }
}

function contactsByL2(contacts: { getEntries(): Promise<Contact[]> }): ContactsByL2 {
  return {
    async findByL2Address(addr) {
      const needle = addr.toLowerCase()
      const match = (await contacts.getEntries()).find(
        (e) =>
          e.tag &&
          (e.addressKind ?? "aztec-l2") === "aztec-l2" &&
          e.address.toLowerCase() === needle,
      )
      return match?.tag ? { tag: match.tag } : null
    },
  }
}

export interface SyncHandle {
  coordinator: WalletSyncCoordinator
  transactions: TransactionStorage
  balances: BalanceStorage
  scope: string
  token: { address: string; symbol: string; decimals: number }
  readBalance(): Promise<bigint | undefined>
  list(): Promise<Transaction[]>
  tick(): Promise<void>
  stop(): void
}

export async function openSync(rt: Runtime): Promise<SyncHandle> {
  const { account } = await rt.account()
  const tokenService = await rt.tokenService()
  const token = await tokenService.fetchTokenInformation()
  const networkId = `${rt.network}:${(await rt.node.getNodeInfo()).rollupVersion}`
  setActiveNetworkId(networkId)
  const transactions = TransactionStorage.get(rt.storage)
  const balances = BalanceStorage.get(rt.storage)
  const scope = balanceScope(rt.network, account.getCompleteAddress().toString())
  const tag = (await rt.account()).unlocked.file.identity?.tag
  const coordinator = new WalletSyncCoordinator({
    source: createWalletSyncSource({
      readBalance: () => tokenService.readBalanceAssumingSynced(),
      wallet: rt.wallet,
      tokenAddress: token.address,
      accountAddress: account.getAddress().toString(),
    }),
    storage: rt.storage,
    transactionStore: transactions,
    tags: createTagForwardResolver((t) => resolveTagViaRegistry(t, registryOpts(rt))),
    contacts: contactsByL2(ContactStorage.get(rt.storage)),
    token: { address: token.address, symbol: token.symbol, decimals: token.decimals },
    balance: { store: balances, scope, tokenAddress: token.address },
    transactions,
    withdrawals: WithdrawalStorage.get(rt.storage),
  })
  const context = {
    accountAddress: account.getAddress().toString(),
    accountTag: tag ?? account.getAddress().toString(),
    networkId,
  }
  let started = false
  return {
    coordinator,
    transactions,
    balances,
    scope,
    token,
    readBalance: () => balances.getBalance(scope, token.address),
    list: () => transactions.getTransactions(),
    async tick() {
      if (!started) {
        started = true
        await coordinator.start(context)
      } else {
        await coordinator.tickNow()
      }
    },
    stop: () => coordinator.stop(),
  }
}
