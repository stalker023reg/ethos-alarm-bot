import cron from 'node-cron';
import type { Telegraf } from 'telegraf';
import { config } from '../config/config';
import { getSnapshotSubscribers, getWorkerState, setWorkerState } from '../db/db';
import { SnapshotService, type SnapshotProposal } from '../services/snapshotService';
import { TelegramDeliveryService } from '../services/telegramDeliveryService';
import { logger } from '../utils/logger';

const LAST_POLL_KEY = 'snapshot_last_poll_ts';
const telegramDeliveryService = new TelegramDeliveryService();
const snapshotService = new SnapshotService();

let isRunning = false;

export function startSnapshotWorker(bot: Telegraf): void {
  logger.info('Snapshot notification worker started');

  const runWorker = async (): Promise<void> => {
    if (isRunning) {
      logger.warn('Snapshot worker overlaps, skipping iteration');
      return;
    }

    isRunning = true;
    try {
      logger.info('Polling Snapshot for new proposals...');

      // 1. Get last poll timestamp
      const lastPollTsStr = await getWorkerState(LAST_POLL_KEY);
      // Default to 24 hours ago if no state exists
      const lastPollTs = lastPollTsStr ? Number(lastPollTsStr) : Math.floor(Date.now() / 1000) - 86400;

      // 2. Fetch new proposals
      const proposals = await snapshotService.fetchNewProposals(lastPollTs);
      
      // If we find exactly the same timestamp, filter out duplicates already notified
      // actually created_gte might return the same ones. 
      // Safe to store the max created timestamp from the batch.
      let maxCreated = lastPollTs;
      const newProposals = proposals.filter(p => !lastPollTsStr || p.start > lastPollTs);

      if (newProposals.length === 0) {
        logger.info('No new Snapshot proposals found');
        return;
      }

      logger.info(`Found ${newProposals.length} new Snapshot proposals`);

      // 3. Get subscribers
      const subscribers = await getSnapshotSubscribers();

      // 4. Send notifications
      for (const proposal of newProposals) {
        const message = formatSnapshotMessage(proposal);
        logger.info('Delivering Snapshot notification', { proposalId: proposal.id, subscribersCount: subscribers.length });

        for (const sub of subscribers) {
          try {
            await telegramDeliveryService.sendMessage(bot.telegram, sub.tgId, message);
          } catch (error) {
            logger.error('Failed to deliver Snapshot notification to user', {
              tgId: sub.tgId,
              proposalId: proposal.id,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        if (proposal.start > maxCreated) {
           maxCreated = proposal.start;
        }
      }

      // 5. Commit state
      await setWorkerState(LAST_POLL_KEY, String(maxCreated));
      logger.info('Completed Snapshot worker iteration', { newProposals: newProposals.length });

    } catch (error) {
      logger.error('Snapshot worker iteration failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      isRunning = false;
    }
  };

  function formatSnapshotMessage(proposal: SnapshotProposal): string {
    const endDate = new Date(proposal.end * 1000).toLocaleString();
    const url = snapshotService.getProposalUrl(proposal.id);

    return [
      '📩 New Ethos Proposal on Snapshot!',
      '',
      `📝 Title: ${proposal.title}`,
      `⏳ Ends: ${endDate}`,
      '',
      `🔗 Link: ${url}`,
    ].join('\n');
  }

  // Startup run
  void runWorker();
  
  // Schedule
  cron.schedule(config.workers.snapshotPollCron, runWorker);
}
