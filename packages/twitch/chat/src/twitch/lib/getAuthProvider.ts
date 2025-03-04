import { RefreshingAuthProvider } from '@twurple/auth'

import { hasTokens } from './hasTokens.js'
import { prisma } from '../../db/prisma.js'

let authProvider: RefreshingAuthProvider | null = null

export const getAuthProvider = function () {
  if (!hasTokens) throw new Error('Missing twitch tokens')
  if (authProvider) return authProvider

  authProvider = new RefreshingAuthProvider({
    clientId: process.env.TWITCH_CLIENT_ID ?? '',
    clientSecret: process.env.TWITCH_CLIENT_SECRET ?? '',
    onRefresh: (twitchId, newTokenData) => {
      console.log('[TWITCHSETUP] Refreshing twitch tokens', { twitchId })

      prisma.account
        .update({
          where: {
            providerAccountId: twitchId,
          },
          data: {
            scope: newTokenData.scope.join(' '),
            access_token: newTokenData.accessToken,
            refresh_token: newTokenData.refreshToken!,
            expires_at: Math.floor(
              new Date(newTokenData.obtainmentTimestamp).getTime() / 1000 +
                (newTokenData.expiresIn ?? 0),
            ),
            expires_in: newTokenData.expiresIn ?? 0,
            obtainment_timestamp: new Date(newTokenData.obtainmentTimestamp),
          },
        })
        .then(() => {
          console.log('[TWITCHSETUP] Updated bot tokens', { twitchId })
        })
        .catch((e) => {
          console.error('[TWITCHSETUP] Failed to update bot tokens', {
            twitchId,
            error: e,
          })
        })
    },
  })

  return authProvider
}
