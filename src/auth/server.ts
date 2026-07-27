import axios from 'axios';
import cors from 'cors';
import express from 'express';
import { cleanupExpiredLoginSessions, consumeLoginSession, getLoginSession } from '../db/db';
import { AuthService, EthosUserNotFoundError, upsertTelegramUser } from '../services/authService';

const app = express();
const authService = new AuthService();

async function notifyTelegramUser(telegramId: string, xUsername: string, profileId: string): Promise<void> {
  const telegramToken = process.env.TELEGRAM_TOKEN?.trim();

  if (!telegramToken) {
    console.warn('telegram_link_notification_skipped', {
      telegramId,
      reason: 'missing_telegram_token',
      timestamp: new Date().toISOString(),
    });
    return;
  }

  await axios.post(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
    chat_id: telegramId,
    text: [
      'Ethos profile linked successfully.',
      '',
      `Username: @${xUsername}`,
      `Profile ID: ${profileId}`,
      '',
      'Now you can use /me and /xp in the bot.',
    ].join('\n'),
  }, {
    timeout: 10_000,
  });
}

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

app.get('/auth/config', (_req, res) => {
  const privyAppId = process.env.PRIVY_APP_ID?.trim() || '';
  const privyClientId = process.env.PRIVY_CLIENT_ID?.trim() ?? '';
  const missing = !privyAppId ? ['PRIVY_APP_ID'] : [];

  if (missing.length > 0) {
    return res.status(503).json({
      error: `Missing required environment variables: ${missing.join(', ')}`,
    });
  }

  return res.json({
    privyAppId,
    privyClientId: privyClientId || undefined,
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'ethos-auth-server',
  });
});

app.post('/link-telegram', async (req, res) => {
  const { loginToken, privyToken, xUsername } = req.body as {
    loginToken?: string;
    privyToken?: string;
    xUsername?: string;
  };
  const timestamp = new Date().toISOString();

  console.log('Link request', {
    hasLoginToken: Boolean(loginToken),
    ip: req.ip,
    timestamp,
  });

  if (!loginToken || !privyToken || !xUsername) {
    return res.status(400).json({
      error: 'Missing loginToken, privyToken, or xUsername',
    });
  }

  try {
    const session = await consumeLoginSession(loginToken);
    if (!session) {
      const existingSession = await getLoginSession(loginToken);

      if (existingSession && existingSession.expires_at.getTime() <= Date.now()) {
        console.warn('login_token_expired', {
          telegramId: existingSession.telegram_id,
          ip: req.ip,
          timestamp,
        });

        return res.status(400).json({
          error: 'Login token expired',
        });
      }

      console.warn('login_token_invalid', {
        ip: req.ip,
        timestamp,
      });

      return res.status(400).json({
        error: 'Invalid or expired login token',
      });
    }

    const telegramId = session.telegram_id;
    console.log('login_token_consumed', {
      telegramId,
      ip: req.ip,
      timestamp,
    });

    const resolvedUser = await authService.resolveEthosUserByUsername(xUsername);
    const profileId = resolvedUser.profileId;
    const resolvedUsername = resolvedUser.username;

    if (!profileId) {
      return res.status(400).json({
        error: 'Missing profileId from Ethos response',
      });
    }

    await upsertTelegramUser({
      telegramId: String(telegramId),
      profileId,
      xUsername: resolvedUsername,
      privyToken,
    });

    console.log('Telegram linked', {
      telegramId,
      profileId,
      xUsername: resolvedUsername,
    });

    try {
      await notifyTelegramUser(telegramId, resolvedUsername, profileId);
    } catch (error) {
      console.error('telegram_link_notification_failed', {
        telegramId,
        error: error instanceof Error ? error.message : error,
        timestamp: new Date().toISOString(),
      });
    }

    return res.json({
      success: true,
      linked: true,
      profileId,
      xUsername: resolvedUsername,
    });
  } catch (err) {
    if (err instanceof EthosUserNotFoundError) {
      return res.status(404).json({
        error: err.message,
      });
    }

    console.error('Ethos verification failed', {
      error: err instanceof Error ? err.message : err,
    });
    return res.status(500).json({
      error: 'Failed to link Telegram account',
    });
  }
});

app.listen(3002, () => {
  console.log('Auth server running');
  console.log('Auth page: http://localhost:3002/auth.html?token=LOGIN_TOKEN');
});

const cleanupInterval = setInterval(async () => {
  try {
    const deletedCount = await cleanupExpiredLoginSessions();

    if (deletedCount > 0) {
      console.log('login_token_expired', {
        deletedCount,
        ip: 'internal',
        timestamp: new Date().toISOString(),
      });
    }
  } catch (error) {
    console.error('login_token_cleanup_failed', {
      error: error instanceof Error ? error.message : error,
      timestamp: new Date().toISOString(),
    });
  }
}, 10 * 60 * 1000);

cleanupInterval.unref();
