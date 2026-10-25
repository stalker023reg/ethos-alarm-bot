import axios from 'axios';
import { config } from '../config/config';
import { getWorkerState } from '../db/db';
import { getSlashActivityByTxHash, type EthosNotification } from './notifications';
import { logger } from '../utils/logger';

const ETHOS_SLASH_ADDRESS = '0xB2C41DebA270E1eA6abBe0e2fA70432630634a59'.toLowerCase();
const SLASH_CREATED_TOPIC0 = '0x1de3714b9e1c673dd48e1119f3d30048d6e6d3cd4f32ab3bb876f8a92d0b8a92';
const BASESCAN_TX_URL = 'https://basescan.org/tx/';
export const BASE_SLASH_WORKER_STATE_KEY = 'base_slash_last_block';
const INITIAL_LOOKBACK_BLOCKS = 20;
const MAX_BLOCK_RANGE = 2000;
const MAX_CATCHUP_BLOCKS = 50_000;

interface BaseRpcResponse<T> {
  result?: T;
  error?: {
    code: number;
    message: string;
  };
}

interface BaseLog {
  address: string;
  blockNumber: string;
  transactionHash: string;
}

interface BaseTransaction {
  hash: string;
  from: string;
  to: string | null;
}

interface BaseBlock {
  timestamp: string;
}

function hexToNumber(value: string): number {
  return Number.parseInt(value, 16);
}

function numberToHex(value: number): string {
  return `0x${value.toString(16)}`;
}

function shortenAddress(address: string): string {
  if (!address || address.length < 10) {
    return address;
  }

  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

async function callBaseRpc<T>(method: string, params: unknown[]): Promise<T> {
  const rpcUrls = [
    config.base.rpcUrl,
    'https://base-rpc.publicnode.com',
    'https://1rpc.io/base',
    'https://mainnet.base.org',
  ].filter((url, idx, arr) => Boolean(url) && arr.indexOf(url) === idx);

  let lastError: Error | null = null;
  for (const rpcUrl of rpcUrls) {
    try {
      const response = await axios.post<BaseRpcResponse<T>>(
        rpcUrl,
        {
          jsonrpc: '2.0',
          id: Date.now(),
          method,
          params,
        },
        {
          timeout: 15_000,
          headers: {
            'Content-Type': 'application/json',
          },
        },
      );

      if (response.data.error) {
        throw new Error(`Base RPC ${method} failed on ${rpcUrl}: ${response.data.error.message}`);
      }

      if (typeof response.data.result === 'undefined') {
        throw new Error(`Base RPC ${method} returned no result from ${rpcUrl}`);
      }

      return response.data.result;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (rpcUrls.length > 1) {
        logger.warn(`Base RPC ${method} failed on ${rpcUrl}, trying fallback...`, {
          error: lastError.message,
        });
      }
    }
  }

  throw lastError ?? new Error(`All Base RPC endpoints failed for ${method}`);
}

async function getLatestBlockNumber(): Promise<number> {
  const latestBlockHex = await callBaseRpc<string>('eth_blockNumber', []);
  return hexToNumber(latestBlockHex);
}

async function getSlashLogs(fromBlock: number, toBlock: number): Promise<BaseLog[]> {
  return callBaseRpc<BaseLog[]>('eth_getLogs', [
    {
      address: ETHOS_SLASH_ADDRESS,
      fromBlock: numberToHex(fromBlock),
      toBlock: numberToHex(toBlock),
      topics: [SLASH_CREATED_TOPIC0],
    },
  ]);
}

async function getTransaction(txHash: string): Promise<BaseTransaction | null> {
  return callBaseRpc<BaseTransaction | null>('eth_getTransactionByHash', [txHash]);
}

async function getBlockTimestamp(blockNumber: number): Promise<string> {
  const block = await callBaseRpc<BaseBlock | null>('eth_getBlockByNumber', [numberToHex(blockNumber), false]);

  if (!block?.timestamp) {
    return new Date().toISOString();
  }

  return new Date(hexToNumber(block.timestamp) * 1000).toISOString();
}

export interface OnchainSlashBatch {
  notifications: EthosNotification[];
  fromBlock: number;
  toBlock: number;
  latestBlock: number;
}

export async function getOnchainSlashBatch(): Promise<OnchainSlashBatch> {
  const latestBlock = await getLatestBlockNumber();
  const storedState = await getWorkerState(BASE_SLASH_WORKER_STATE_KEY);
  let fromBlock: number;

  if (!storedState) {
    fromBlock = Math.max(latestBlock - INITIAL_LOOKBACK_BLOCKS, 0);
    logger.info('Base slash cursor initialized', {
      fromBlock,
      latestBlock,
    });
  } else {
    fromBlock = Math.min(Number(storedState) + 1, latestBlock);
    const gap = latestBlock - fromBlock;

    if (gap > MAX_CATCHUP_BLOCKS) {
      const skippedFrom = fromBlock;
      fromBlock = Math.max(latestBlock - INITIAL_LOOKBACK_BLOCKS, 0);
      logger.warn('Base slash cursor was too far behind, skipping ahead to avoid stale notifications', {
        skippedFrom,
        skippedTo: fromBlock,
        skippedBlocks: fromBlock - skippedFrom,
        latestBlock,
      });
    }
  }

  if (fromBlock > latestBlock) {
    return {
      notifications: [],
      fromBlock,
      toBlock: latestBlock,
      latestBlock,
    };
  }

  const toBlock = Math.min(fromBlock + MAX_BLOCK_RANGE - 1, latestBlock);
  const logs = await getSlashLogs(fromBlock, toBlock);

  logger.info('Base slash logs fetched', {
    fromBlock,
    toBlock,
    count: logs.length,
  });

  const transactionHashes = [...new Set(logs.map((log) => log.transactionHash))];
  const blockNumbers = [...new Set(logs.map((log) => hexToNumber(log.blockNumber)))];

  const transactionMap = new Map<string, BaseTransaction | null>();
  for (const txHash of transactionHashes) {
    transactionMap.set(txHash, await getTransaction(txHash));
  }

  const blockTimestampMap = new Map<number, string>();
  for (const blockNumber of blockNumbers) {
    blockTimestampMap.set(blockNumber, await getBlockTimestamp(blockNumber));
  }

  const notifications: EthosNotification[] = [];

  for (const txHash of transactionHashes) {
    const relatedLog = logs.find((log) => log.transactionHash === txHash);
    if (!relatedLog) {
      continue;
    }

    const blockNumber = hexToNumber(relatedLog.blockNumber);
    const tx = transactionMap.get(txHash);
    const actorAddress = tx?.from ?? 'unknown';
    const enriched = await getSlashActivityByTxHash(txHash);

    notifications.push({
      id: enriched?.id ?? `base-slash:${txHash}`,
      type: 'SLASH_CREATE',
      slashId: enriched?.slashId,
      title: enriched?.title,
      createdAt: enriched?.createdAt ?? blockTimestampMap.get(blockNumber) ?? new Date().toISOString(),
      metadata: {
        author: {
          username: enriched?.metadata?.author && typeof enriched.metadata.author === 'object' && 'username' in enriched.metadata.author
            ? String((enriched.metadata.author as Record<string, unknown>).username ?? shortenAddress(actorAddress))
            : shortenAddress(actorAddress),
          address: actorAddress,
        },
        target: {
          username: enriched?.metadata?.target && typeof enriched.metadata.target === 'object' && 'username' in enriched.metadata.target
            ? String((enriched.metadata.target as Record<string, unknown>).username ?? 'unknown')
            : 'unknown',
        },
        comment: enriched?.metadata?.comment,
        amount: enriched?.metadata?.amount,
        txHash,
        blockNumber,
        contractAddress: relatedLog.address,
        link: enriched?.metadata?.link ?? (enriched?.slashId ? `https://app.ethos.network/activity/slash/${enriched.slashId}` : undefined),
        explorerUrl: `${BASESCAN_TX_URL}${txHash}`,
        source: enriched?.metadata?.source ?? 'base',
      },
    });
  }

  return {
    notifications,
    fromBlock,
    toBlock,
    latestBlock,
  };
}

export async function getOnchainSlashNotifications(): Promise<EthosNotification[]> {
  const batch = await getOnchainSlashBatch();
  return batch.notifications;
}
