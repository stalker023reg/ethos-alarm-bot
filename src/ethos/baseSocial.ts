import axios from 'axios';
import { config } from '../config/config';
import { getWorkerState } from '../db/db';
import { getSlashActivityByTxHash, type EthosNotification } from './notifications';
import { logger } from '../utils/logger';

// Ethos Contract Addresses on Base
const ETHOS_VOUCH_ADDRESS = '0x7a20d99307172d8f6b80bf1e904bbf060420e394'.toLowerCase();
const ETHOS_REVIEW_ADDRESS = '0x6d3a8fd5cf89f9a429bfadfd970968f646aff325'.toLowerCase();

// Topic0 Signatures
const VOUCHED_TOPIC0 = '0x162d509d6569eed753c8c9cb8680140420e39400c188d07487abfcea77a82469';
const REVIEW_CREATED_TOPIC0 = '0xbcba601f87e317f5f2e5d40544c705eb73096974a8f4836ca5c4cd8f012451d9';

export const BASE_SOCIAL_WORKER_STATE_KEY = 'base_social_last_block';
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
  topics: string[];
  data: string;
}

function hexToNumber(value: string): number {
  return Number.parseInt(value, 16);
}

function numberToHex(value: number): string {
  return `0x${value.toString(16)}`;
}

/**
 * Extracts the target address from an Ethos Vouch or Review log.
 * Topic structure for Vouched: [TOPIC0, fromProfileId, toProfileId, toAddress]
 * Topic structure for ReviewCreated: [TOPIC0, score, authorAddress, targetAddress] 
 * (Actually, we should use the enriched API data to be 100% sure, but topic matching is fast).
 */
function extractTargetAddress(log: BaseLog): string | null {
  const topic0 = log.topics[0]?.toLowerCase();
  
  if (topic0 === VOUCHED_TOPIC0) {
    // Vouched(uint256 vouchId, uint256 authorProfileId, uint256 subjectProfileId, address subjectAddress, ...)
    // subjectAddress is in the data section (not indexed), at the first word (offset 0).
    const data = log.data;
    if (data && data.length >= 66) {
      // 0x + 64 chars. address is the last 40 chars of the first 64-char block.
      return `0x${data.slice(26, 66)}`.toLowerCase();
    }
  }

  if (topic0 === REVIEW_CREATED_TOPIC0) {
    // ReviewCreated(uint8,address,bytes32,address,...)
    // According to Basescan, the target address is in topics[3] or data.
    const topic3 = log.topics[3];
    if (topic3 && topic3.length === 66) {
      return `0x${topic3.slice(26)}`.toLowerCase();
    }
  }

  return null;
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

export interface OnchainSocialEvent {
  txHash: string;
  targetAddress: string;
  type: 'VOUCH' | 'REVIEW';
  blockNumber: number;
}

export async function getOnchainSocialBatch(): Promise<{
  events: OnchainSocialEvent[];
  fromBlock: number;
  toBlock: number;
}> {
  const latestBlock = await getLatestBlockNumber();
  const storedState = await getWorkerState(BASE_SOCIAL_WORKER_STATE_KEY);
  let fromBlock: number;

  if (!storedState) {
    fromBlock = Math.max(latestBlock - INITIAL_LOOKBACK_BLOCKS, 0);
    logger.info('Base social cursor initialized', { fromBlock, latestBlock });
  } else {
    fromBlock = Math.min(Number(storedState) + 1, latestBlock);
    const gap = latestBlock - fromBlock;

    if (gap > MAX_CATCHUP_BLOCKS) {
      const skippedFrom = fromBlock;
      fromBlock = Math.max(latestBlock - INITIAL_LOOKBACK_BLOCKS, 0);
      logger.warn('Base social cursor was too far behind, skipping ahead to avoid stale notifications', {
        skippedFrom,
        skippedTo: fromBlock,
        skippedBlocks: fromBlock - skippedFrom,
        latestBlock,
      });
    }
  }

  if (fromBlock > latestBlock) {
    return { events: [], fromBlock, toBlock: latestBlock };
  }

  const toBlock = Math.min(fromBlock + MAX_BLOCK_RANGE - 1, latestBlock);

  // Poll logs for both contracts
  const logs = await callBaseRpc<BaseLog[]>('eth_getLogs', [
    {
      address: [ETHOS_VOUCH_ADDRESS, ETHOS_REVIEW_ADDRESS],
      fromBlock: numberToHex(fromBlock),
      toBlock: numberToHex(toBlock),
      topics: [[VOUCHED_TOPIC0, REVIEW_CREATED_TOPIC0]],
    },
  ]);

  const events: OnchainSocialEvent[] = logs.map((log) => {
    const targetAddress = extractTargetAddress(log);
    const type: 'VOUCH' | 'REVIEW' = log.topics[0]?.toLowerCase() === VOUCHED_TOPIC0 ? 'VOUCH' : 'REVIEW';
    
    return {
      txHash: log.transactionHash,
      targetAddress: targetAddress || 'unknown',
      type,
      blockNumber: hexToNumber(log.blockNumber),
    };
  }).filter(e => e.targetAddress !== 'unknown');

  logger.info('On-chain social logs fetched', {
    fromBlock,
    toBlock,
    logCount: logs.length,
    eventCount: events.length,
  });

  return { events, fromBlock, toBlock };
}
