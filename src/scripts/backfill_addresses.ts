import { 
  getProfilesMissingAddresses, 
  updateProfileAddress, 
  initializeDatabase 
} from '../db/db';
import { ethosClient } from '../ethos/ethosClient';
import { logger } from '../utils/logger';
import * as dotenv from 'dotenv';

dotenv.config();

async function fetchWalletAddress(profileId: string): Promise<string | null> {
  try {
    const response = await ethosClient.post('/activities/profile/received', { 
      userkey: `profileId:${profileId}`, 
      limit: 1 
    });
    
    const items = response.data.values || response.data.items || [];
    if (items.length === 0) {
      logger.warn(`No activities found for profile ${profileId}, cannot derive address yet.`);
      return null;
    }

    const userkeys: string[] = items[0].subjectUser?.userkeys || [];
    const addressKey = userkeys.find(k => k.startsWith('address:'));
    
    return addressKey ? addressKey.split(':')[1].toLowerCase() : null;
  } catch (error) {
    logger.error(`Failed to fetch address for profile ${profileId}`, {
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
}

async function backfill() {
  logger.info('Starting address backfill...');
  await initializeDatabase();
  
  const missing = await getProfilesMissingAddresses();
  logger.info(`Found ${missing.length} profiles missing addresses.`);

  for (const profileId of missing) {
    logger.info(`Processing profile ${profileId}...`);
    const address = await fetchWalletAddress(profileId);
    
    if (address) {
      await updateProfileAddress(profileId, address);
      logger.info(`Updated profile ${profileId} with address ${address}`);
    } else {
      logger.warn(`Could not find address for profile ${profileId}`);
    }
    
    // Small delay to be nice to the API
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  logger.info('Backfill complete.');
  process.exit(0);
}

backfill().catch(err => {
  logger.error('Backfill failed', err);
  process.exit(1);
});
