import { toUserName } from '@twurple/chat'

import { findHero } from '../../db/getHero'
import prisma from '../../db/prisma'
import { isCustomGame, server } from '../../dota'
import { findUserByName } from '../../dota/dotaGSIClients'
import { getRankDescription } from '../../utils/constants'
import { getChatClient } from '../setup'

// Setup twitch chat bot client first
export const chatClient = await getChatClient()

const CooldownManager = {
  // 30 seconds
  cooldownTime: 30 * 1000,
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
const commands = ['!pleb', '!gpm', '!hero', '!mmr', '!mmr=', '!ping', '!help', '!xpm']
chatClient.onMessage(function (channel, user, text, msg) {
  // Letting one pleb in
  if (plebMode.has(channel) && !msg.userInfo.isSubscriber) {
    plebMode.delete(channel)
    void chatClient.say(channel, '/subscribers')
    void chatClient.say(channel, `${user} EZ Clap`)
    return
  }

  if (!text.startsWith('!')) return

  const args = text.split(' ')
  const command = args[0].toLowerCase()
  if (!commands.includes(command)) return
  if (!CooldownManager.canUse(channel, command)) return

  const connectedSocketClient = findUserByName(toUserName(channel))

  switch (command) {
    case '!help':
      void chatClient.say(channel, commands.join(' '))
      break
    case '!pleb':
      // Only mod or owner
      if (!msg.userInfo.isBroadcaster && !msg.userInfo.isMod) break

      plebMode.add(channel)
      void chatClient.say(channel, '/subscribersoff')
      void chatClient.say(channel, 'One pleb IN 👇')
      break
    case '!xpm': {
      if (!connectedSocketClient?.gsi) break
      if (isCustomGame(connectedSocketClient.gsi)) break

      const xpm = connectedSocketClient.gsi.gamestate?.player?.xpm

      if (!xpm) {
        void chatClient.say(channel, 'No xpm')
        break
      }

      void chatClient.say(channel, `Live XPM: ${xpm}`)
      break
    }
    case '!gpm': {
      if (!connectedSocketClient?.gsi) break
      if (isCustomGame(connectedSocketClient.gsi)) break

      const gpm = connectedSocketClient.gsi.gamestate?.player?.gpm

      if (!gpm) {
        void chatClient.say(channel, 'No GPM')
        break
      }

      void chatClient.say(channel, `Live GPM: ${gpm}`)
      break
    }
    case '!hero': {
      if (!connectedSocketClient?.gsi) break
      if (isCustomGame(connectedSocketClient.gsi)) break
      if (!connectedSocketClient.gsi.gamestate?.hero?.name) {
        void chatClient.say(channel, 'Not playing PauseChamp')
        break
      }

      const hero = findHero(connectedSocketClient.gsi.gamestate.hero.name || '')

      if (!hero) {
        void chatClient.say(channel, "Couldn't find hero Sadge")
        break
      }

      void chatClient.say(
        channel,
        `${hero.aliases}. Primary attribute: ${hero.attr_primary}. ${hero.roles.replaceAll(
          '|',
          ', ',
        )}`.toLowerCase(),
      )
      break
    }
    case '!mmr=': {
      // Only mod or owner
      if (!msg.userInfo.isBroadcaster && !msg.userInfo.isMod) break

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
              providerAccountId: msg.channelId ?? '',
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
                .emit('update-medal', { mmr, steam32Id: msg.channelId })
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
      // If connected, we can just respond with the cached MMR
      if (connectedSocketClient) {
        console.log('[MMR] Responding with cached MMR', connectedSocketClient.mmr, channel)

        getRankDescription(connectedSocketClient.mmr, connectedSocketClient.steam32Id ?? undefined)
          .then((description) => {
            console.log('[MMR] Responding with cached MMR', description, channel)

            void chatClient.say(channel, description)
          })
          .catch((e) => {
            console.log('[MMR] Failed to get rank description', e, channel)
          })
        return
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
            providerAccountId: msg.channelId ?? '',
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

  Sadge
  EZ
  Clap
  peepoGamble
  PauseChamp

Commands coming soon:
  !dotabod to show all commands

Commands that are fun:
  !modsonly = enable submode and delete chatters that arent mods
  !nonfollowersonly = can only chat if you're not a follower xd

When hero alch, show GPM

*/
