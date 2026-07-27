import axios from 'axios';
import { ethosClient } from '../ethos/ethosClient';
import { getPeriodicRewards } from '../ethos/xp';
import { logger } from '../utils/logger';
import { AuthService } from './authService';

export interface UserXpSummary {
  totalXp: number;
  weeklyXp: number | null;
  rank: number | null;
  xpStreakDays: number;
  todayEarnings: number;
  yesterdayEarnings: number;
  rewardsBreakdown: DailyRewardsSummary;
  currentWeeklyTotals?: any;
}

export interface DailyRewardsSummary {
  vouchPoolReward: number;
  votePoolReward: number;
  commentPoolReward: number;
  marketHoldPoolReward: number;
  marketTradePoolReward: number;
  delegationReward: number;
  slashReward: number;
  dailyStreakReward: number;
  otherReward: number;
}

interface XpResponseShape {
  xpTotal?: number;
  weeklyXp?: number;
  xpWeekly?: number;
  rank?: number;
  xpRank?: number;
  xpStreakDays?: number;
  stats?: {
    xp?: {
      weekly?: number;
      rank?: number;
    };
  };
}

interface PeriodicRewardsShape {
  weeklyTotals?: {
    vouchPoolReward?: number;
    votePoolReward?: number;
    commentPoolReward?: number;
    marketHoldPoolReward?: number;
    marketTradePoolReward?: number;
    delegationReward?: number;
    slashStakeReturned?: number;
    slashStakeWon?: number;
    slashVoterReward?: number;
    slashVoteReward?: number;
    slashVoteRefund?: number;
  };
}

function asFiniteNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return fallback;
}

function asOptionalFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function extractWeeklyXp(profile: any): number | null {
  return (
    profile?.weeklyXp ??
    profile?.stats?.weeklyXp ??
    profile?.xp?.weekly ??
    null
  );
}

function extractRank(profile: any): number | null {
  return (
    profile?.rank ??
    profile?.globalRank ??
    profile?.stats?.rank ??
    profile?.leaderboardRank ??
    null
  );
}

/**
 * Fetches XP and reward data for a linked Ethos profile.
 */
export class XpService {
  private readonly authService = new AuthService();

  async getUserXp(profileId: string): Promise<UserXpSummary> {
    try {
      const summary = await this.authService.getProfileSummary(profileId);

      return {
        totalXp: summary.totalXp,
        weeklyXp: summary.weeklyXp,
        rank: summary.rank,
        xpStreakDays: summary.xpStreakDays,
        todayEarnings: 0,
        yesterdayEarnings: 0,
        rewardsBreakdown: this.createEmptyBreakdown(),
      };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        logger.warn('Ethos XP API request failed', {
          profileId,
          status: error.response?.status,
          data: error.response?.data,
        });
      }

      throw error;
    }
  }

  async getFullXpSummary(profileId: string): Promise<UserXpSummary> {
    const [xpBase, rewardsResponse] = await Promise.all([
      this.getUserXp(profileId),
      getPeriodicRewards(profileId),
    ]);

    const breakdown = this.createEmptyBreakdown();
    const totals = rewardsResponse.weeklyTotals;

    if (totals) {
      breakdown.vouchPoolReward = asFiniteNumber(totals.vouchPoolReward, 0);
      breakdown.votePoolReward = asFiniteNumber(totals.votePoolReward, 0);
      breakdown.commentPoolReward = asFiniteNumber(totals.commentPoolReward, 0);
      breakdown.marketHoldPoolReward = asFiniteNumber(totals.marketHoldPoolReward, 0);
      breakdown.marketTradePoolReward = asFiniteNumber(totals.marketTradePoolReward, 0);
      breakdown.delegationReward = asFiniteNumber(totals.delegationReward, 0);
      
      const slash = asFiniteNumber(totals.slashVoterReward, 0) + 
                    asFiniteNumber(totals.slashVoteReward, 0) + 
                    asFiniteNumber(totals.slashStakeWon, 0);
      breakdown.slashReward = slash;
    }

    return {
      ...xpBase,
      todayEarnings: asFiniteNumber(rewardsResponse.today?.userEarnings, 0),
      yesterdayEarnings: asFiniteNumber(rewardsResponse.yesterday?.userEarnings, 0),
      rewardsBreakdown: breakdown,
      currentWeeklyTotals: totals,
    };
  }

  async getDailyRewards(profileId: string): Promise<DailyRewardsSummary> {
    const response = await getPeriodicRewards(profileId);
    return this.aggregateRewards(response.rewards || []);
  }

  private createEmptyBreakdown(): DailyRewardsSummary {
    return {
      vouchPoolReward: 0,
      votePoolReward: 0,
      commentPoolReward: 0,
      marketHoldPoolReward: 0,
      marketTradePoolReward: 0,
      delegationReward: 0,
      slashReward: 0,
      dailyStreakReward: 0,
      otherReward: 0,
    };
  }

  private aggregateRewards(items: any[]): DailyRewardsSummary {
    const breakdown = this.createEmptyBreakdown();

    for (const item of items) {
      const amount = asFiniteNumber(item.amount, 0);
      const id = (item.rewardId || '').toUpperCase();

      if (id.includes('VOUCH_POOL')) {
        breakdown.vouchPoolReward += amount;
      } else if (id.includes('VOTE_POOL')) {
        breakdown.votePoolReward += amount;
      } else if (id.includes('COMMENT_POOL')) {
        breakdown.commentPoolReward += amount;
      } else if (id.includes('MARKET_HOLD_POOL')) {
        breakdown.marketHoldPoolReward += amount;
      } else if (id.includes('MARKET_TRADE_POOL')) {
        breakdown.marketTradePoolReward += amount;
      } else if (id.includes('DELEGATION_REWARD')) {
        breakdown.delegationReward += amount;
      } else if (id.includes('STREAK')) {
        breakdown.dailyStreakReward += amount;
      } else {
        breakdown.otherReward += amount;
      }
    }

    return breakdown;
  }
}
