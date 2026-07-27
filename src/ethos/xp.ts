import { ethosClient } from './ethosClient';
import type { EthosNotification } from './notifications';

export type { EthosNotification };

export interface EthosUserXp {
  userkey: string;
  level?: number;
  totalXp?: number;
  streakDays?: number;
  rank?: number;
  updatedAt?: string;
}

export interface EthosPeriodicReward {
  rewardId: string;
  amount?: number;
  status?: string;
  periodStart?: string;
  periodEnd?: string;
}

export interface EthosPeriodicRewardsResponse {
  profileId: string;
  rewards: EthosPeriodicReward[];
  today?: {
    totalPool?: number;
    userEarnings?: number;
  };
  yesterday?: {
    totalPool?: number;
    userEarnings?: number;
  };
  weeklyTotals?: {
    votePoolReward?: number;
    vouchPoolReward?: number;
    commentPoolReward?: number;
    marketHoldPoolReward?: number;
    marketTradePoolReward?: number;
    delegationReward?: number;
    slashStakeReturned?: number;
    slashStakeWon?: number;
    slashVoterReward?: number;
    slashVoteReward?: number;
    slashVoteRefund?: number;
    total?: number;
  };
}

/**
 * Fetches XP information for an Ethos user key.
 */
export async function getUserXp(userkey: string): Promise<EthosUserXp> {
  const response = await ethosClient.get<EthosUserXp>(`/xp/user/${encodeURIComponent(userkey)}`);

  return response.data;
}

/**
 * Fetches dashboard periodic reward information for a profile.
 */
export async function getPeriodicRewards(profileId: string): Promise<EthosPeriodicRewardsResponse> {
  const response = await ethosClient.get<EthosPeriodicRewardsResponse>(
    `/xp/dashboard/periodic-rewards/${encodeURIComponent(profileId)}`,
  );

  return response.data;
}
