import { PrismaClient } from '@prisma/client'
import axios from 'axios'

import { prisma } from '../db/prisma.js'
import { getBotAPI_DEV_ONLY } from '../twitch/lib/getBotAPI_DEV_ONLY.js'
import { logger } from '../utils/logger.js'

const botApi = await getBotAPI_DEV_ONLY()

console.log('running dev script')
async function fixNewUsers() {
  console.log('running fixNewUsers')
  const users = await prisma.user.findMany({
    select: {
      id: true,
      Account: {
        select: {
          providerAccountId: true,
        },
      },
    },
    where: {
      displayName: null,
    },
  })

  for (const user of users) {
    const account = user.Account
    if (!account?.providerAccountId) {
      console.log('no account for user', user.id)
      continue
    }
    await handleNewUser(account.providerAccountId)
  }
  return
}

await fixNewUsers()

async function handleNewUser(providerAccountId: string) {
  if (!botApi) return
  try {
    const stream = await botApi.streams.getStreamByUserId(providerAccountId)
    const streamer = await botApi.users.getUserById(providerAccountId)
    const follows = botApi.users.getFollowsPaginated({
      followedUser: providerAccountId,
    })
    const totalFollowerCount = await follows.getTotalCount()

    const data = {
      displayName: streamer?.displayName,
      name: streamer?.name,
      followers: totalFollowerCount,
      stream_online: !!stream?.startDate,
      stream_start_date: stream?.startDate ?? null,
    }

    // remove falsy values from data (like displayName: undefined)
    const filteredData = Object.fromEntries(
      Object.entries(data).filter(([key, value]) => Boolean(value)),
    )

    prisma.account
      .update({
        data: {
          user: {
            update: filteredData,
          },
        },
        where: {
          provider_providerAccountId: {
            provider: 'twitch',
            providerAccountId: providerAccountId,
          },
        },
      })
      .then(() => {
        console.log('updated user info for', { providerAccountId, data: filteredData })
      })
      .catch((e) => {
        console.log(e, 'error saving new user info for', e.broadcasterId)
      })
  } catch (e) {
    console.log(e, 'error on getStreamByUserId')
  }
}

async function getAccounts() {
  // const steam32id = 1234
  // const steamserverid = (await server.dota.getUserSteamServer(steam32id)) as string | undefined
  // const response = await axios(
  //   `https://api.steampowered.com/IDOTA2MatchStats_570/GetRealtimeStats/v1/?key=${process.env.STEAM_WEB_API}&server_steam_id=${steamserverid}`,
  // )
  // logger.info(steamserverid)
}

async function getFollows() {
  if (!botApi) return
  const users = await prisma.user.findMany({
    select: {
      id: true,
      Account: {
        select: {
          providerAccountId: true,
        },
      },
    },
    where: {
      followers: null,
    },
  })

  for (const user of users) {
    if (!user.Account?.providerAccountId) continue
    logger.info('checking user id', { id: user.id })
    const follows = botApi.users.getFollowsPaginated({
      followedUser: user.Account.providerAccountId,
    })
    const totalFollowerCount = await follows.getTotalCount()
    await prisma.user.update({
      where: {
        id: user.id,
      },
      data: {
        followers: totalFollowerCount,
      },
    })
  }
}

async function fixWins() {
  const bets = await prisma.bet.findMany({
    select: {
      id: true,
      matchId: true,
      myTeam: true,
    },
    where: {
      won: null,
    },
    skip: 0,
    take: 40,
    orderBy: {
      createdAt: 'desc',
    },
  })

  for (const bet of bets) {
    try {
      const match = await axios(
        `https://api.steampowered.com/IDOTA2Match_570/GetMatchDetails/v1/`,
        {
          params: { key: process.env.STEAM_WEB_API, match_id: bet.matchId },
        },
      )

      if (!match.data?.result?.match_id || typeof match.data?.result?.radiant_win !== 'boolean') {
        continue
      }

      logger.info('the bet found', {
        matchId: match.data?.result?.match_id,
        lobbytype: match.data?.result?.lobby_type,
        won: match.data?.result?.radiant_win && bet.myTeam === 'radiant',
      })

      await prisma.bet.update({
        where: {
          id: bet.id,
        },
        data: {
          won: match.data?.result?.radiant_win && bet.myTeam === 'radiant',
          lobby_type: match.data?.result?.lobby_type,
        },
      })
    } catch (e) {
      continue
    }
  }
}

const topFollowers = async () => {
  const followers = await prisma.user.findMany({
    select: {
      name: true,
      followers: true,
      createdAt: true,
    },
    where: {
      stream_online: true,
    },
    orderBy: {
      followers: 'desc',
    },
    take: 10,
  })

  console.info(
    followers.map((f) => ({
      ...f,
      url: `https://twitch.tv/${f.name}`,
      followers: f.followers?.toLocaleString(),
    })),
  )
}

const getLogQuery = async (name: string) => {
  const user = await prisma.user.findFirst({
    select: {
      name: true,
      id: true,
      Account: {
        select: {
          providerAccountId: true,
        },
      },
      SteamAccount: {
        select: {
          steam32Id: true,
        },
      },
    },
    where: {
      name,
    },
  })

  if (!user) return ''

  return `
channel:${user.name} or
name:${user.name} or
${user.SteamAccount.map((a) => `steam32Id:${a.steam32Id} or`).join(' ')}
token:${user.id} or
userId:${user.id} or
user:${user.id} or
token:${user.Account?.providerAccountId ?? ''} or
message:Starting!
`
}

// console.log(await getLogQuery('grubby'))

/*
server.dota.dota2.on('ready', async () => {
  const steamserverid = (await server.dota.getUserSteamServer(849473199)) ?? ''

  console.log(
    `https://api.steampowered.com/IDOTA2MatchStats_570/GetRealtimeStats/v1/?key=${process.env
      .STEAM_WEB_API!}&server_steam_id=${steamserverid}`,
  )

  server.dota.getGcMatchData(6965705261, (err, response) => {
    console.log('getGcMatchData', { err, response: response?.match?.match_outcome })
    //
  })

  const delayedData = await server.dota.getDelayedMatchData({steamserverid})
  console.log({ delayedData })
})*/

// 2 = radiant
// 3 = dire

async function onlineEvent({ userId, startDate }: { userId: string; startDate: Date }) {
  return await prisma.user.update({
    data: {
      stream_online: true,
      stream_start_date: startDate,
    },
    where: {
      id: userId,
    },
  })
}
async function checkUserOnline({
  providerAccountId,
  userId,
}: {
  providerAccountId: string
  userId: string
}) {
  if (!botApi) return

  console.log('checking', { providerAccountId, userId })
  if (!providerAccountId) return

  try {
    const stream = await botApi.streams.getStreamByUserId(providerAccountId)
    console.log({ stream })
    if (stream?.startDate) {
      await onlineEvent({
        startDate: stream.startDate,
        userId,
      })
    }
  } catch (e) {
    console.log(e, 'error on checkUserOnline')
  }
}

async function fixOnline() {
  const bets = await prisma.bet.findMany({
    where: {
      user: {
        stream_online: {
          not: true,
        },
      },
      createdAt: {
        gte: new Date('2023-01-13T09:46:51.887Z'),
      },
    },
    select: {
      id: true,
      user: {
        select: {
          id: true,
          Account: {
            select: {
              providerAccountId: true,
            },
          },
        },
      },
    },
    distinct: ['userId'],
  })

  for (const bet of bets) {
    await checkUserOnline({
      providerAccountId: bet.user.Account?.providerAccountId ?? '',
      userId: bet.user.id,
    })
  }
}

const newLocales = [
  'en',
  'af-ZA',
  'ar-SA',
  'ca-ES',
  'cs-CZ',
  'da-DK',
  'de-DE',
  'el-GR',
  'es-ES',
  'fa-IR',
  'fi-FI',
  'fr-FR',
  'he-IL',
  'hu-HU',
  'it-IT',
  'ja-JP',
  'ko-KR',
  'nl-NL',
  'no-NO',
  'pl-PL',
  'pt-BR',
  'pt-PT',
  'ro-RO',
  'ru-RU',
  'sr-SP',
  'sv-SE',
  'tr-TR',
  'uk-UA',
  'vi-VN',
  'zh-CN',
  'zh-TW',
]
function mapLocale(locale: string) {
  if (locale.length === 2) {
    return newLocales.find((l) => l.startsWith(locale)) ?? 'en'
  }

  return locale
}

// function to migrate users from old locale 2 letter code to new locale hyphenated string
async function migrateUsersToNewLocale() {
  const users = await prisma.user.findMany({
    where: {
      locale: {
        not: PrismaClient.dbNull,
      },
    },
    select: {
      id: true,
      locale: true,
    },
  })

  const data = users.map((user) => ({
    id: user.id,
    locale: mapLocale(user.locale),
  }))

  // group by locale
  const grouped = data.reduce<Record<string, string[]>>((acc, user) => {
    if (!acc[user.locale]) {
      acc[user.locale] = []
    }

    acc[user.locale].push(user.id)

    return acc
  }, {})

  try {
    for (const locale of Object.keys(grouped)) {
      await prisma.user.updateMany({
        data: {
          locale: locale,
        },
        where: {
          id: {
            in: grouped[locale],
          },
        },
      })
    }
  } catch (e) {
    console.log(e)
  }
}

async function migrateUsersToNewMMROptions() {
  const disabledMmrUsers =
    (await prisma.$queryRaw`SELECT * FROM settings WHERE value is null`) as []
  /*  const disabledMmrUsers = await prisma.setting.findMany({
    where: {
      key: 'mmr-tracker',
      value: PrismaClient.dbNull,
    },
    select: {
      value: true,
      user: {
        select: {
          id: true,
        },
      },
    },
  })*/

  const data = []
  const keys = ['showRankMmr', 'showRankImage', 'showRankLeader']
  // turn these off
  for (const setting of disabledMmrUsers as any) {
    data.push(keys.map((key) => ({ key, value: false, userId: setting.userId })))
  }

  console.log(disabledMmrUsers)
  /* await prisma.setting.createMany({
    data: data.flat(),
    skipDuplicates: true,
  })*/
}
