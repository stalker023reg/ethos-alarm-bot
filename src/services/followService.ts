import { addFollow, getFollowsForUser, removeFollow, getFollowedUsers, updateProfileAddress } from '../db/db';
import { AuthService, type WatchedUser } from './authService';

export class EthosWatchLimitExceededError extends Error {
  constructor() {
    super('Maximum 5 profiles allowed');
    this.name = 'EthosWatchLimitExceededError';
  }
}


/**
 * Manages watched Ethos profiles for Telegram users.
 */
export class FollowService {
  private readonly authService = new AuthService();

  async watchUser(tgUserId: number, xUsername: string): Promise<WatchedUser> {
    const existingFollows = await getFollowedUsers(tgUserId);
    if (existingFollows.length >= 5) {
      throw new EthosWatchLimitExceededError();
    }

    const resolvedUser = await this.authService.resolveEthosUserByUsername(xUsername);
    await addFollow(tgUserId, resolvedUser.profileId);

    if (resolvedUser.walletAddress) {
      await updateProfileAddress(resolvedUser.profileId, resolvedUser.walletAddress);
    }

    return {
      profileId: resolvedUser.profileId,
      username: resolvedUser.username,
    };
  }

  async unwatchUser(tgUserId: number, xUsername: string): Promise<WatchedUser> {
    const resolvedUser = await this.authService.resolveEthosUserByUsername(xUsername);
    await removeFollow(tgUserId, resolvedUser.profileId);

    return {
      profileId: resolvedUser.profileId,
      username: resolvedUser.username,
    };
  }

  async getWatchedUsers(tgUserId: number): Promise<string[]> {
    const follows = await getFollowsForUser(tgUserId);
    const usernames: string[] = [];

    for (const follow of follows) {
      try {
        const profile = await this.authService.getProfileSummary(follow.target_profile_id);
        usernames.push(profile.username);
      } catch {
        usernames.push(follow.target_profile_id);
      }
    }

    return usernames;
  }
}
