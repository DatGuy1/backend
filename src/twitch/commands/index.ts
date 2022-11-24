import { toUserName } from '@twurple/chat'

import { prisma } from '../../db/prisma'
import { server } from '../../dota'
import { findUserByName } from '../../dota/lib/connectedStreamers'
import getHero from '../../dota/lib/getHero'
import { isSpectator } from '../../dota/lib/isSpectator'
import { getRankDescription } from '../../dota/lib/ranks'
import axios from '../../utils/axios'
import { getChatClient } from '../lib/getChatClient'

// Setup twitch chat bot client first
export const chatClient = await getChatClient()

const CooldownManager = {
  // 30 seconds
  cooldownTime: 15 * 1000,
  store: new Map<string, number>(),

  canUse: function (channel: string, commandName: string) {
    // Check if the last time you've used the command + 30 seconds has passed
    // (because the value is less then the current time)
    if (!this.store.has(`${channel}.${commandName}`)) return true

    return (
      (this.store.get(`${channel}.${commandName}`) ?? Date.now()) + this.cooldownTime < Date.now()
    )
  },

  touch: function (channel: string, commandName: string) {
    // Store the current timestamp in the store based on the current commandName
    this.store.set(`${channel}.${commandName}`, Date.now())
  },
}

const plebMode = new Set()
const modMode = new Set()
const commands = [
  '!gpm',
  '!hero',
  '!mmr',
  '!ping',
  '!xpm',
  '!apm',
  '!wl',
  '!dotabod',
  '!help',
  '!pleb',
  '!commands',
  '!modsonly',
  '!refresh',
  '!mmr=',
]
chatClient.onMessage(function (channel, user, text, msg) {
  // Letting one pleb in
  if (plebMode.has(channel) && !msg.userInfo.isSubscriber) {
    plebMode.delete(channel)
    void chatClient.say(channel, '/subscribers')
    void chatClient.say(channel, `${user} EZ Clap`)
    return
  }

  // Letting one pleb in
  if (modMode.has(channel) && !(msg.userInfo.isMod || msg.userInfo.isBroadcaster)) {
    void chatClient.deleteMessage(channel, msg)
    return
  }

  if (!text.startsWith('!')) return

  const args = text.split(' ')
  const command = args[0].toLowerCase()
  if (!commands.includes(command)) return
  if (!CooldownManager.canUse(channel, command)) return

  const connectedSocketClient = findUserByName(toUserName(channel))

  switch (command) {
    case '!modsonly':
      // Only mod or owner
      if (!msg.userInfo.isBroadcaster && !msg.userInfo.isMod) break

      if (modMode.has(channel)) {
        void chatClient.say(channel, 'Mods only mode disabled Sadge')
        modMode.delete(channel)
        break
      }

      // Delete all messages that are not from a mod
      modMode.add(channel)
      void chatClient.say(channel, '/subscribers')
      void chatClient.say(channel, 'Mods only mode enabled BASED Clap')
      break
    case '!commands':
      void chatClient.say(channel, `Available commands: ${commands.join(' | ')}`)
      break
    case '!refresh':
      // Only mod or owner
      if (!msg.userInfo.isBroadcaster && !msg.userInfo.isMod) break

      if (connectedSocketClient?.sockets.length) {
        void chatClient.say(channel, 'Refreshing overlay...')
        server.io.to(connectedSocketClient.sockets).emit('refresh')
      }

      break
    case '!dotabod':
    case '!help':
      void chatClient.say(
        channel,
        `I'm an open source bot made by @techleed. More info: https://dotabod.com`,
      )
      break
    case '!wl': {
      if (!connectedSocketClient?.steam32Id) {
        void chatClient.say(channel, 'Not live PauseChamp')
        break
      }

      const promises = [
        axios(
          `https://api.opendota.com/api/players/${connectedSocketClient.steam32Id}/wl/?date=0.5&lobby_type=0`,
        ),
        axios(
          `https://api.opendota.com/api/players/${connectedSocketClient.steam32Id}/wl/?date=0.5&lobby_type=7`,
        ),
      ]

      Promise.all(promises)
        .then((values: { data: { win: number; lose: number } }[]) => {
          const [unranked, ranked] = values
          const { win, lose } = ranked.data
          const { win: unrankedWin, lose: unrankedLose } = unranked.data
          const hasUnranked = unrankedWin + unrankedLose !== 0
          const hasRanked = win + lose !== 0
          const rankedMsg = `Ranked ${win} W - ${lose} L`
          const unrankedMsg = `Unranked ${unrankedWin} W - ${unrankedLose} L`
          const msg = []
          if (hasRanked) msg.push(rankedMsg)
          if (hasUnranked) msg.push(unrankedMsg)
          void chatClient.say(channel, msg.join(' | '))
        })
        .catch((e) => {
          console.log(e)
          void chatClient.say(channel, 'Unknown WL')
        })

      break
    }
    case '!pleb':
      // Only mod or owner
      if (!msg.userInfo.isBroadcaster && !msg.userInfo.isMod) break

      plebMode.add(channel)
      void chatClient.say(channel, '/subscribersoff')
      void chatClient.say(channel, 'One pleb IN 👇')
      break
    case '!xpm': {
      if (!connectedSocketClient?.gsi) break
      if (isSpectator(connectedSocketClient.gsi)) break

      const xpm = connectedSocketClient.gsi.gamestate?.player?.xpm

      if (!xpm) {
        void chatClient.say(channel, 'No xpm')
        break
      }

      void chatClient.say(channel, `Live XPM: ${xpm}`)
      break
    }
    case '!apm': {
      if (!connectedSocketClient?.gsi) break
      if (isSpectator(connectedSocketClient.gsi)) break

      const commandsIssued = connectedSocketClient.gsi.gamestate?.player?.commands_issued ?? 0

      if (!commandsIssued) {
        void chatClient.say(channel, 'No APM yet')
        break
      }

      const gameTime = connectedSocketClient.gsi.gamestate?.map?.game_time ?? 1
      const apm = Math.round(commandsIssued / (gameTime / 60))
      console.log(gameTime, commandsIssued, apm)

      void chatClient.say(channel, `Live APM: ${apm} Chatting`)
      break
    }
    case '!gpm': {
      if (!connectedSocketClient?.gsi) break
      if (isSpectator(connectedSocketClient.gsi)) break

      const gpm = connectedSocketClient.gsi.gamestate?.player?.gpm

      if (!gpm) {
        void chatClient.say(channel, 'No GPM')
        break
      }

      const gold_from_hero_kills = connectedSocketClient.gsi.gamestate?.player?.gold_from_hero_kills
      const gold_from_creep_kills =
        connectedSocketClient.gsi.gamestate?.player?.gold_from_creep_kills

      void chatClient.say(
        channel,
        `Live GPM: ${gpm}. ${gold_from_hero_kills ?? 0} from hero kills, ${
          gold_from_creep_kills ?? 0
        } from creep kills.`,
      )
      break
    }
    case '!hero': {
      if (!connectedSocketClient?.gsi || !connectedSocketClient.steam32Id) break
      if (isSpectator(connectedSocketClient.gsi)) break
      if (!connectedSocketClient.gsi.gamestate?.hero?.name) {
        void chatClient.say(channel, 'Not playing PauseChamp')
        break
      }

      const hero = getHero(connectedSocketClient.gsi.gamestate.hero.name)

      if (!hero) {
        void chatClient.say(channel, "Couldn't find hero Sadge")
        break
      }

      axios(
        `https://api.opendota.com/api/players/${connectedSocketClient.steam32Id}/wl/?hero_id=${hero.id}&having=1&date=30`,
      )
        .then(({ data }: { data: { win: number; lose: number } }) => {
          if (data.win + data.lose === 0) {
            void chatClient.say(channel, `No matches played as ${hero.localized_name} in 30d.`)
            return
          }

          // Divide by zero error
          if (data.win === 0 && data.lose > 0) {
            void chatClient.say(
              channel,
              `Winrate: 0% as ${hero.localized_name} in 30d of ${data.lose} matches.`,
            )
            return
          }

          const winrate = Math.round((data.win / (data.win + data.lose)) * 100)
          void chatClient.say(
            channel,
            `Winrate: ${winrate}% as ${hero.localized_name} in 30d of ${
              data.lose + data.win
            } matches.`,
          )
        })
        .catch((e) => {
          void chatClient.say(channel, `Playing ${hero.localized_name}`)
          console.log(e)
        })

      break
    }
    case '!mmr=': {
      // Only mod or owner
      if (!msg.userInfo.isBroadcaster && !msg.userInfo.isMod) break
      if (!msg.channelId) break

      const mmr = args[1]

      if (!mmr || !Number(mmr) || Number(mmr) > 20000) {
        console.log('Invalid mmr', mmr, channel)

        break
      }
      prisma.account
        .update({
          data: {
            user: {
              update: {
                mmr: Number(mmr),
              },
            },
          },
          where: {
            provider_providerAccountId: {
              provider: 'twitch',
              providerAccountId: msg.channelId,
            },
          },
        })
        .then(() => {
          void chatClient.say(channel, `Updated MMR to ${mmr}`)
          if (connectedSocketClient) {
            connectedSocketClient.mmr = Number(mmr)

            if (connectedSocketClient.sockets.length) {
              console.log(
                '[MMR] Sending mmr to socket',
                connectedSocketClient.mmr,
                connectedSocketClient.sockets,
                channel,
              )

              server.io
                .to(connectedSocketClient.sockets)
                .emit('update-medal', { mmr, steam32Id: connectedSocketClient.steam32Id })
            } else {
              console.log('[MMR] No sockets found to send update to', channel)
            }
          }
        })
        .catch(() => {
          void chatClient.say(channel, `Failed to update MMR to ${mmr}`)
        })

      break
    }
    case '!mmr':
      if (!msg.channelId) break

      // If connected, we can just respond with the cached MMR
      if (connectedSocketClient) {
        getRankDescription(connectedSocketClient.mmr, connectedSocketClient.steam32Id ?? undefined)
          .then((description) => {
            // console.log('[MMR] Responding with cached MMR', description, channel)

            void chatClient.say(channel, description)
          })
          .catch((e) => {
            console.log('[MMR] Failed to get rank description', e, channel)
          })
        break
      }

      console.log('[MMR] Fetching MMR from database', channel)

      // Do a DB lookup if the streamer is offline from OBS or Dota
      prisma.account
        .findFirst({
          select: {
            user: {
              select: {
                mmr: true,
                steam32Id: true,
              },
            },
          },
          where: {
            providerAccountId: msg.channelId,
          },
        })
        .then((account) => {
          if (!account?.user.mmr) {
            console.log('[MMR] No MMR found in database', account, channel)
            return
          }
          getRankDescription(account.user.mmr, account.user.steam32Id ?? undefined)
            .then((description) => {
              void chatClient.say(channel, description)
            })
            .catch((e) => {
              console.log('[MMR] Failed to get rank description', e, channel)
            })
        })
        .catch((e) => {
          console.log('[MMR] Error fetching MMR from database', e, channel)
        })

      break
    case '!ping':
      void chatClient.say(channel, 'Pong EZ Clap')
      break
    default:
      break
  }

  CooldownManager.touch(channel, command)
})

/*
  Required emotes:

  BASED
  Chatting
  massivePIDAS
  Sadge
  EZ
  Clap
  peepoGamble
  PauseChamp

Commands that are fun:
  !nonfollowersonly = can only chat if you're not a follower xd
*/
