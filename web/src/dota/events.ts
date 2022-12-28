import { delayedGames } from '../../prisma/generated/mongoclient/index.js'
import { getWL } from '../db/getWL.js'
import { prisma } from '../db/prisma.js'
import { DBSettings, defaultSettings, getValueOrDefault } from '../db/settings.js'
import Mongo from '../steam/mongo.js'
import { chatClient } from '../twitch/index.js'
import { closeTwitchBet } from '../twitch/lib/closeTwitchBet.js'
import { disabledBets, openTwitchBet } from '../twitch/lib/openTwitchBet.js'
import { DotaEvent, DotaEventTypes, Packet, Player, SocketClient } from '../types.js'
import axios from '../utils/axios.js'
import { fmtMSS, steamID64toSteamID32 } from '../utils/index.js'
import { logger } from '../utils/logger.js'
import { server } from './index.js'
import checkMidas from './lib/checkMidas.js'
import { calculateManaSaved } from './lib/checkTreadToggle.js'
import { blockTypes, pickSates } from './lib/consts.js'
import { findItem } from './lib/findItem.js'
import { getAccountsFromMatch } from './lib/getAccountsFromMatch.js'
import getHero, { HeroNames } from './lib/getHero.js'
import { getHeroNameById } from './lib/heroes.js'
import { isArcade } from './lib/isArcade.js'
import { isPlayingMatch } from './lib/isPlayingMatch.js'
import { isSpectator } from './lib/isSpectator.js'
import { getRankDetail } from './lib/ranks.js'
import { updateMmr } from './lib/updateMmr.js'
import { events } from './server.js'

const mongo = await Mongo.connect()

export const blockCache = new Map<string, string>()

const passiveItemNames = [
  { name: 'item_magic_stick', title: 'magic stick', charges: true },
  { name: 'item_magic_wand', title: 'magic wand', charges: true },
  { name: 'item_faerie_fire', title: 'faerie fire' },
  { name: 'item_cheese', title: 'cheese' },
  { name: 'item_holy_locket', title: 'holy locket', charges: true },
  { name: 'item_mekansm', title: 'mek' },
  { name: 'item_satanic', title: 'satanic' },
  { name: 'item_guardian_greaves', title: 'greaves' },
]

// Finally, we have a user and a GSI client
// That means the user opened OBS and connected to Dota 2 GSI
export class setupMainEvents {
  client: SocketClient

  // Server could reboot and lose these in memory
  // But that's okay they will get reset based on current match state
  aegisPickedUp?: { playerId: number; expireTime: string; expireDate: Date }
  playingMatchId: string | undefined | null = null
  playingTeam: 'radiant' | 'dire' | 'spectator' | undefined | null = null
  playingHeroSlot: number | undefined | null = null
  playingHero: HeroNames | undefined | null = null
  playingLobbyType: number | undefined | null = null
  players: ReturnType<typeof getAccountsFromMatch> | undefined | null = null
  savingSteamServerId = false
  steamServerTries = 0
  events: DotaEvent[] = []
  passiveMidas = { counter: 0, timer: 0, used: 0 }
  roshanKilled?: {
    minTime: string
    maxTime: string
    minDate: Date
    maxDate: Date
  }
  endingBets = false
  openingBets = false
  creatingSteamAccount = false
  treadsData = { manaAtLastToggle: 0, timeOfLastToggle: 0 }

  constructor(client: SocketClient) {
    this.client = client
    this.watchEvents()
  }

  private getMmr() {
    return this.client.mmr
  }

  private getToken() {
    return this.client.token
  }

  private getChannel() {
    return this.client.name
  }

  private getSteam32() {
    return this.client.steam32Id
  }

  private getChannelId(): string {
    return this.client.Account?.providerAccountId ?? ''
  }

  private addSecondsToNow(seconds: number) {
    return new Date(new Date().getTime() + seconds * 1000)
  }

  private say(message: string, delay = true) {
    if (!delay) {
      void chatClient.say(this.getChannel(), message)
      return
    }

    setTimeout(() => {
      void chatClient.say(this.getChannel(), message)
    }, 7000)
  }

  // reset vars when a new match begins
  private resetClientState(resetBets = false) {
    logger.info('newMatchNewVars', {
      resetBets,
      name: this.client.name,
      matchid: this.playingMatchId,
    })
    this.playingHero = null
    this.playingHeroSlot = null
    this.events = []
    this.passiveMidas = { counter: 0, timer: 0, used: 0 }
    this.savingSteamServerId = false
    this.steamServerTries = 0

    // Bet stuff should be closed by endBets()
    // This should mean an entire match is over
    if (resetBets) {
      this.client.steamserverid = undefined
      this.endingBets = false
      this.openingBets = false
      this.playingMatchId = null
      this.playingTeam = null

      this.roshanKilled = undefined
      this.aegisPickedUp = undefined

      server.io.to(this.getToken()).emit('aegis-picked-up', {})
      server.io.to(this.getToken()).emit('roshan-killed', {})
    }
  }

  // Runs every gametick
  async saveMatchData() {
    // Not gonna save any when local. Assuming we're just testing in local lobbys
    if (process.env.NODE_ENV === 'development') return

    if (!this.client.steam32Id || !this.client.gsi?.map?.matchid) return
    if (!Number(this.client.gsi.map.matchid)) return
    if (this.client.steamserverid) return
    if (this.savingSteamServerId) return

    this.savingSteamServerId = true
    try {
      // logger.info('Start match data', this.client.name, this.client.gsi.map.matchid)

      const response = (await mongo
        .collection('delayedGames')
        .findOne({ 'match.match_id': this.client.gsi.map.matchid })) as unknown as delayedGames

      if (!response) {
        // logger.info(
        //   'No match data for user, checking from steam',
        //   this.client.name,
        //   this.client.gsi.map.matchid,
        // )

        const steamserverid = (await server.dota.getUserSteamServer(this.client.steam32Id)) as
          | string
          | undefined
        if (!steamserverid) {
          // 35 5s tries
          // that's 3 minutes, should have full hero ids by then...right?
          if (this.steamServerTries > 35) {
            return
          }
          logger.info('Retry steamserverid', {
            tries: this.steamServerTries,
            channel: this.client.name,
            matchid: this.client.gsi.map.matchid,
          })
          setTimeout(() => {
            this.steamServerTries += 1
            this.savingSteamServerId = false
          }, 5000)
          return
        }

        this.client.steamserverid = steamserverid
        this.savingSteamServerId = false

        const delayedData = await server.dota.getDelayedMatchData(steamserverid, true)
        if (!delayedData) {
          logger.info('No match data found!', {
            name: this.client.name,
            matchid: this.client.gsi.map.matchid,
          })
          return
        }

        this.playingLobbyType = delayedData.match.lobby_type
        this.players = getAccountsFromMatch(delayedData)

        if (this.client.stream_online) {
          this.say('Match data found !np · !smurfs · !gm · !lg · !avg commands activated.', false)
        }
      } else {
        this.playingLobbyType = response.match.lobby_type
        this.players = getAccountsFromMatch(response)
        logger.info('Match data already found', {
          name: this.client.name,
          matchid: this.client.gsi.map.matchid,
        })
      }
    } catch (e) {
      logger.info('saving match data failed', { name: this.client.name, e })
    }
  }

  watchEvents() {
    events.on(`${this.getToken()}:${DotaEventTypes.RoshanKilled}`, (event: DotaEvent) => {
      if (!isPlayingMatch(this.client.gsi)) return
      if (!this.client.stream_online) return

      // doing map gametime - event gametime in case the user reconnects to a match,
      // and the gametime is over the event gametime
      const gameTimeDiff = (this.client.gsi?.map?.game_time ?? event.game_time) - event.game_time

      // min spawn for rosh in 5 + 3 minutes
      const minS = 5 * 60 + 3 * 60 - gameTimeDiff
      const minTime = (this.client.gsi?.map?.clock_time ?? 0) + minS

      // max spawn for rosh in 5 + 3 + 3 minutes
      const maxS = 5 * 60 + 3 * 60 + 3 * 60 - gameTimeDiff
      const maxTime = (this.client.gsi?.map?.clock_time ?? 0) + maxS

      // server time
      const minDate = this.addSecondsToNow(minS)
      const maxDate = this.addSecondsToNow(maxS)

      const res = {
        minS,
        maxS,
        minTime: fmtMSS(minTime),
        maxTime: fmtMSS(maxTime),
        minDate,
        maxDate,
      }

      this.roshanKilled = res
      server.io.to(this.getToken()).emit('roshan-killed', res)
    })

    // Event 'courier_killed'
    // courier_team: string // 'dire',
    // killer_player_id: number // 1,
    // owning_player_id: number // 5
    events.on(`${this.getToken()}:${DotaEventTypes.CourierKilled}`, (event: DotaEvent) => {
      if (!isPlayingMatch(this.client.gsi)) return
      if (!this.client.stream_online) return

      const heroName = getHeroNameById(
        this.players?.matchPlayers[event.killer_player_id].heroid ?? 0,
        event.killer_player_id,
      )

      logger.info('COURIER EVENT', {
        event,
        client: this.getChannel(),
        matchid: this.playingMatchId,
        heroSlot: this.playingHeroSlot,
        players: this.players,
        heroName,
      })

      // beta opt in only
      if (!this.client.beta_tester) return

      if (event.owning_player_id === this.playingHeroSlot) {
        logger.info('STREAMERS COURIER!', { matchid: this.playingMatchId })
        this.say(`Courier micro ICANT thanks ${heroName}`)
      }
    })

    events.on(`${this.getToken()}:${DotaEventTypes.Tip}`, (event: DotaEvent) => {
      if (!isPlayingMatch(this.client.gsi)) return
      if (!this.client.stream_online) return

      const heroName = getHeroNameById(
        this.players?.matchPlayers[event.sender_player_id].heroid ?? 0,
        event.sender_player_id,
      )

      logger.info('TIP EVENT', {
        event,
        client: this.getChannel(),
        matchid: this.playingMatchId,
        heroSlot: this.playingHeroSlot,
        players: this.players,
        heroName,
      })

      // beta opt in only
      if (!this.client.beta_tester) return

      if (event.receiver_player_id === this.playingHeroSlot) {
        logger.info('TIPPED STREAMER!', { matchid: this.playingMatchId })
        this.say(`The tip from ${heroName} ICANT`)
      }
    })

    events.on(`${this.getToken()}:${DotaEventTypes.BountyPickup}`, (event: DotaEvent) => {
      if (!isPlayingMatch(this.client.gsi)) return
      if (!this.client.stream_online) return

      const heroName = getHeroNameById(
        this.players?.matchPlayers[event.player_id].heroid ?? 0,
        event.player_id,
      )

      logger.info('BOUNTY EVENT', {
        event,
        client: this.getChannel(),
        matchid: this.playingMatchId,
        heroSlot: this.playingHeroSlot,
        players: this.players,
        heroName,
      })

      // beta opt in only
      if (!this.client.beta_tester) return

      if (event.team === this.playingTeam) {
        logger.info('BOUNTY FOR OUR TEAM!', { matchid: this.playingMatchId })

        this.say(
          `Nice ${event.team_gold} in bounty gold for ${event.team} EZ Clap Thanks ${heroName}`,
        )
      } else {
        logger.info('BOUNTY FOR ENEMY TEAM!', { matchid: this.playingMatchId })

        this.say(
          `${event.team_gold} in bounty gold for ${event.team} picked up by ${heroName} monkaS`,
        )
      }
    })

    events.on(`${this.getToken()}:${DotaEventTypes.AegisPickedUp}`, (event: DotaEvent) => {
      if (!isPlayingMatch(this.client.gsi)) return
      if (!this.client.stream_online) return

      const gameTimeDiff = (this.client.gsi?.map?.game_time ?? event.game_time) - event.game_time

      // expire for aegis in 5 minutes
      const expireS = 5 * 60 - gameTimeDiff
      const expireTime = (this.client.gsi?.map?.clock_time ?? 0) + expireS

      // server time
      const expireDate = this.addSecondsToNow(expireS)

      const res = {
        expireS,
        playerId: event.player_id,
        expireTime: fmtMSS(expireTime),
        expireDate,
      }

      this.aegisPickedUp = res

      server.io.to(this.getToken()).emit('aegis-picked-up', res)
    })

    // Catch all
    events.on(`${this.getToken()}:newdata`, (data: Packet) => {
      // New users who dont have a steamaccount saved yet
      // This needs to run first so we have client.steamid on multiple acts
      this.updateSteam32Id()

      // In case they connect to a game in progress and we missed the start event
      this.setupOBSBlockers(data.map?.game_state ?? '')

      if (!isPlayingMatch(this.client.gsi)) return

      // Everything below here requires an ongoing match, not a finished match
      const hasWon = this.client.gsi?.map?.win_team && this.client.gsi.map.win_team !== 'none'
      if (hasWon) return

      // Can't just !this.heroSlot because it can be 0
      const purchaser = this.client.gsi?.items?.teleport0?.purchaser
      if (typeof this.playingHeroSlot !== 'number' && typeof purchaser === 'number') {
        logger.info('[SLOT] Found hero slot at', {
          purchaser,
          name: this.getChannel(),
        })
        this.playingHeroSlot = purchaser
        void this.saveMatchData()
        return
      }

      // beta testers only
      if (this.client.beta_tester) {
        const manaSaved = calculateManaSaved(this.treadsData, this.client.gsi)
        if (manaSaved) {
          this.say(`Mana saved by tread switching ${manaSaved} EZ Clap`)
          logger.info('[TREAD SWITCHER] Mana saved', {
            channel: this.getChannel(),
            manaSaved,
            matchid: this.client.gsi?.map?.matchid,
          })
        }
      }

      // Always runs but only until steam is found
      void this.saveMatchData()

      // TODO: Move this to server.ts
      const newEvents = data.events?.filter((event) => {
        const existingEvent = this.events.find(
          (e) => e.game_time === event.game_time && e.event_type === event.event_type,
        )
        return !existingEvent
      })

      if (newEvents?.length) {
        this.events = [...this.events, ...newEvents]

        newEvents.forEach((event) => {
          events.emit(`${this.getToken()}:${event.event_type}`, event)

          if (!Object.values(DotaEventTypes).includes(event.event_type)) {
            logger.info('[NEWEVENT]', event)
          }
        })
      }

      this.openBets()

      const chatterEnabled = getValueOrDefault(DBSettings.chatter, this.client.settings)
      const chatters = getValueOrDefault(
        DBSettings.chatters,
        this.client.settings,
      ) as typeof defaultSettings['chatters']
      if (chatterEnabled && chatters.midas.enabled && this.client.stream_online) {
        const isMidasPassive = checkMidas(data, this.passiveMidas)

        if (isMidasPassive === true) {
          logger.info('[MIDAS] Passive midas', { name: this.getChannel() })
          this.say(chatters.midas.message)
        }
        if (typeof isMidasPassive === 'number') {
          this.say(`Midas was finally used, ${isMidasPassive} seconds late Madge`)
        }
      }
    })

    events.on(`${this.getToken()}:hero:name`, (name: HeroNames) => {
      if (!isPlayingMatch(this.client.gsi)) return

      this.playingHero = name
    })

    events.on(`${this.getToken()}:hero:alive`, (alive: boolean) => {
      if (!this.client.stream_online) return
      if (!isPlayingMatch(this.client.gsi)) return

      const chatterEnabled = getValueOrDefault(DBSettings.chatter, this.client.settings)
      if (!chatterEnabled) return

      const chatters = getValueOrDefault(
        DBSettings.chatters,
        this.client.settings,
      ) as typeof defaultSettings['chatters']

      if (!chatters.passiveDeath.enabled) return

      if (!alive && this.client.gsi?.previously?.hero?.alive) {
        const couldHaveLivedWith = findItem(
          passiveItemNames.map((i) => i.name),
          false,
          this.client.gsi,
        )

        if (Array.isArray(couldHaveLivedWith) && couldHaveLivedWith.length) {
          const itemNames = couldHaveLivedWith
            .map((item) => {
              const found = passiveItemNames.find((i) => {
                if (i.name !== item.name) return false
                if (Number(item.cooldown) > 0 || !item.can_cast) return false
                if (i.charges) {
                  return Number(item.charges) > 0
                }
                return true
              })
              if (found) return found.title
              return null
            })
            .flatMap((f) => f ?? [])
            .join(', ')

          if (!itemNames) return

          const heroName =
            getHero(this.playingHero ?? this.client.gsi.hero?.name)?.localized_name ?? 'We'

          this.say(
            `${chatters.passiveDeath.message
              .replace('[itemnames]', itemNames)
              .replace('[heroname]', heroName)}`,
          )
        }
      }
    })

    events.on(`${this.getToken()}:hero:smoked`, (isSmoked: boolean) => {
      if (!this.client.stream_online) return
      if (!isPlayingMatch(this.client.gsi)) return
      const chatterEnabled = getValueOrDefault(DBSettings.chatter, this.client.settings)
      if (!chatterEnabled) return

      const chatters = getValueOrDefault(
        DBSettings.chatters,
        this.client.settings,
      ) as typeof defaultSettings['chatters']

      if (!chatters.smoke.enabled) return

      if (isSmoked) {
        const heroName =
          getHero(this.playingHero ?? this.client.gsi?.hero?.name)?.localized_name ?? 'We'
        this.say(chatters.smoke.message.replace('[heroname]', heroName))
      }
    })

    events.on(`${this.getToken()}:map:paused`, (isPaused: boolean) => {
      if (!this.client.stream_online) return

      if (!isPlayingMatch(this.client.gsi)) return
      const chatterEnabled = getValueOrDefault(DBSettings.chatter, this.client.settings)

      // Necessary to let the frontend know, so we can pause any rosh / aegis / etc timers
      server.io.to(this.getToken()).emit('paused', isPaused)

      const chatters = getValueOrDefault(
        DBSettings.chatters,
        this.client.settings,
      ) as typeof defaultSettings['chatters']
      if (isPaused && chatterEnabled && chatters.pause.enabled) {
        this.say(chatters.pause.message)
      }
    })

    // This wont get triggered if they click disconnect and dont wait for the ancient to go to 0
    events.on(`${this.getToken()}:map:win_team`, (winningTeam: 'radiant' | 'dire') => {
      if (!isPlayingMatch(this.client.gsi)) return

      this.endBets(winningTeam)
    })
  }

  emitWLUpdate() {
    if (!this.client.stream_online) return

    getWL(this.getChannelId(), this.client.stream_start_date)
      .then(({ record }) => {
        logger.info('[STEAM32ID] Emitting WL overlay update', {
          name: this.getChannel(),
        })
        server.io.to(this.getToken()).emit('update-wl', record)
      })
      .catch((e) => {
        // Stream not live
        // console.error('[MMR] emitWLUpdate Error getting WL', {e: e?.message || e})
      })
  }

  emitBadgeUpdate() {
    getRankDetail(this.getMmr(), this.getSteam32())
      .then((deets) => {
        logger.info('[STEAM32ID] Emitting badge overlay update', {
          name: this.getChannel(),
        })
        server.io.to(this.getToken()).emit('update-medal', deets)
      })
      .catch((e) => {
        logger.error('[MMR] emitBadgeUpdate Error getting rank detail', { e: e?.message || e })
      })
  }

  // Make sure user has a steam32Id saved in the database
  // This runs once per every match start
  // the user may have a steam account saved, but not this one for this match
  // so add to their list of steam accounts
  updateSteam32Id() {
    if (this.creatingSteamAccount) return
    if (!this.client.gsi?.player?.steamid) return
    // TODO: Not sure if .accountid actually exists for a solo gsi in non spectate mode
    if (this.getSteam32() === Number(this.client.gsi.player.accountid)) return

    const steam32Id = steamID64toSteamID32(this.client.gsi.player.steamid)
    if (!steam32Id) return

    // It's the same user, no need to create a new act
    if (this.getSteam32() === steam32Id) return

    // User already has a steam32Id and its saved to the `steam_accounts` table
    const foundAct = this.client.SteamAccount.find((act) => act.steam32Id === steam32Id)
    // Logged into a new account (smurfs vs mains)
    if (foundAct) {
      this.client.mmr = foundAct.mmr
      this.client.steam32Id = steam32Id
      this.emitBadgeUpdate()
      return
    } // else we create this act in db

    // Default to the mmr from `users` table for this brand new steam account
    // this.getMmr() should return mmr from `user` table on new accounts without steam acts
    const mmr = this.client.SteamAccount.length ? 0 : this.getMmr()

    logger.info('[STEAM32ID] Running steam account lookup to db', { name: this.getChannel() })

    this.creatingSteamAccount = true
    // Get mmr from database for this steamid
    prisma.steamAccount
      .findFirst({ where: { steam32Id } })
      .then(async (res) => {
        // not found, need to make
        if (!res?.id) {
          logger.info('[STEAM32ID] Adding steam32Id', { name: this.getChannel() })
          await prisma.steamAccount.create({
            data: {
              mmr,
              steam32Id,
              userId: this.getToken(),
              name: this.client.gsi?.player?.name,
            },
          })
          await prisma.user.update({ where: { id: this.getToken() }, data: { mmr: 0 } })
          // Logged into a new account (smurfs vs mains)
          this.client.mmr = mmr
          this.client.steam32Id = steam32Id
          this.emitBadgeUpdate()
        } else {
          // We should never arrive here
          logger.info('ERROR We should never be here', { name: this.getChannel() })
          this.client.mmr = res.mmr
          this.client.steam32Id = steam32Id
        }

        this.creatingSteamAccount = false
      })
      .catch((e) => {
        this.creatingSteamAccount = false
        logger.info('[DATABASE ERROR]', { e: e?.message || e })
      })
  }

  updateMMR(
    increase: boolean,
    lobbyType: number,
    matchId: string,
    isParty?: boolean,
    heroSlot?: number | null,
  ) {
    const ranked = lobbyType === 7

    // This also updates WL for the unranked matches
    prisma.bet
      .update({
        where: {
          matchId_userId: {
            matchId: matchId,
            userId: this.getToken(),
          },
        },
        data: {
          won: increase,
          lobby_type: lobbyType,
          hero_slot: heroSlot,
          is_party: isParty,
        },
      })
      .then(() => {
        //
      })
      .catch((e) => {
        logger.error('[DATABASE ERROR MMR]', {
          e: e?.message || e,
          matchId,
          isParty,
          increase,
          lobbyType,
        })
      })

    this.emitWLUpdate()

    if (!ranked) {
      return
    }

    const mmrSize = isParty ? 20 : 30
    const newMMR = this.getMmr() + (increase ? mmrSize : -mmrSize)
    if (this.client.steam32Id) {
      updateMmr(newMMR, this.client.steam32Id, this.client.name)
    }
  }

  // TODO: CRON Job
  // 1 Find bets that are open and don't equal this match id and close them
  // 2 Next, check if the prediction is still open
  // 3 If it is, steam dota2 api result of match
  // 4 Then, tell twitch to close bets based on win result
  openBets() {
    if (
      !!this.playingMatchId &&
      !!this.client.gsi?.map?.matchid &&
      this.playingMatchId !== this.client.gsi.map.matchid
    ) {
      // We have the wrong matchid, reset vars and start over
      logger.info('openBets resetClientState because stuck on old match id', {
        name: this.getChannel(),
        playingMatchId: this.playingMatchId,
        matchid: this.client.gsi.map.matchid,
      })
      this.resetClientState(true)
    }

    // The bet was already made
    if (this.playingMatchId !== null) return
    if (this.openingBets) return

    // Why open if not playing?
    if (this.client.gsi?.player?.activity !== 'playing') return

    // Why open if won?
    if (this.client.gsi.map?.win_team !== 'none') return

    // We at least want the hero name so it can go in the twitch bet title
    if (!this.client.gsi.hero?.name || !this.client.gsi.hero.name.length) return

    this.openingBets = true
    const channel = this.getChannel()

    // It's not a live game, so we don't want to open bets nor save it to DB
    if (!this.client.gsi.map.matchid || this.client.gsi.map.matchid === '0') return

    // Check if this bet for this match id already exists, dont continue if it does
    prisma.bet
      .findFirst({
        select: {
          id: true,
          myTeam: true,
          matchId: true,
        },
        where: {
          userId: this.getToken(),
          matchId: this.client.gsi.map.matchid,
          won: null,
        },
      })
      .then((bet) => {
        // Saving to local memory so we don't have to query the db again
        if (bet?.id) {
          logger.info('[BETS] Found a bet in the database', { id: bet.id })
          this.playingMatchId = bet.matchId
          this.playingTeam = bet.myTeam as Player['team_name']
          this.openingBets = false
          return
        }

        this.playingMatchId = this.client.gsi?.map?.matchid ?? null
        this.playingTeam = this.client.gsi?.player?.team_name ?? null

        prisma.bet
          .create({
            data: {
              // TODO: Replace prediction id with the twitch api bet id result
              predictionId: this.client.gsi?.map?.matchid ?? '',
              matchId: this.client.gsi?.map?.matchid ?? '',
              userId: this.getToken(),
              myTeam: this.client.gsi?.player?.team_name ?? '',
              steam32Id: this.getSteam32(),
            },
          })
          .then(() => {
            const betsEnabled = getValueOrDefault(DBSettings.bets, this.client.settings)
            if (!betsEnabled) {
              this.openingBets = false
              return
            }

            if (!this.client.stream_online) {
              logger.info('[BETS] Not opening bets bc stream is offline for', {
                name: this.client.name,
              })
              this.openingBets = false
              return
            }

            const hero = getHero(this.client.gsi?.hero?.name)

            openTwitchBet(this.getToken(), hero?.localized_name, this.client.settings)
              .then(() => {
                this.say(`Bets open peepoGamble`)
                this.openingBets = false
                logger.info('[BETS] open bets', {
                  event: 'open_bets',
                  data: {
                    matchId: this.client.gsi?.map?.matchid,
                    user: this.getToken(),
                    player_team: this.client.gsi?.player?.team_name,
                  },
                })
              })
              .catch((e: any) => {
                if (disabledBets.has(this.getToken())) {
                  // disable the bet in settings for this user
                  prisma.setting
                    .upsert({
                      where: {
                        key_userId: {
                          key: DBSettings.bets,
                          userId: this.getToken(),
                        },
                      },
                      create: {
                        userId: this.getToken(),
                        key: DBSettings.bets,
                        value: false,
                      },
                      update: {
                        value: false,
                      },
                    })
                    .then((r) => {
                      disabledBets.delete(this.getToken())
                      logger.info('[BETS] Disabled bets for user', {
                        channel,
                      })
                      this.openingBets = false
                    })
                    .catch((e) => {
                      logger.info('[BETS] Error disabling bets', { e: e?.message || e })
                      this.openingBets = false
                    })
                } else {
                  logger.info('[BETS] Error opening twitch bet', { channel, e: e?.message || e })
                  this.openingBets = false
                }
              })
          })
          .catch((e: any) => {
            logger.error(`[BETS] Could not add bet to channel`, {
              channel: this.getChannel(),
              e: e?.message || e,
            })
            this.openingBets = false
          })
      })
      .catch((e: any) => {
        logger.error('[BETS] Error opening bet', {
          matchId: this.client.gsi?.map?.matchid ?? '',
          channel,
          e: e?.message || e,
        })
        this.openingBets = false
      })
  }

  endBets(winningTeam: 'radiant' | 'dire' | null = null) {
    if (process.env.NODE_ENV === 'development') {
      this.resetClientState(true)
      return
    }

    if (this.openingBets || !this.playingMatchId || this.endingBets) {
      return
    }

    const matchId = this.playingMatchId
    const betsEnabled = getValueOrDefault(DBSettings.bets, this.client.settings)
    const betsMessage = betsEnabled ? 'Mods need to end bets manually. ' : ''

    // An early without waiting for ancient to blow up
    // We have to check every few seconds on Opendota to see if the match is over
    if (!winningTeam) {
      logger.info('[BETS] Streamer exited the match before it ended with a winner', {
        name: this.getChannel(),
        matchId,
        openingBets: this.openingBets,
        endingBets: this.endingBets,
      })

      // Check with opendota to see if the match is over
      axios(`https://api.steampowered.com/IDOTA2Match_570/GetMatchDetails/v1/`, {
        params: { key: process.env.STEAM_WEB_API, match_id: matchId },
      })
        .then((response: { data: any }) => {
          logger.info('Found an early dc match data', { matchId, channel: this.getChannel() })

          let winningTeam: 'radiant' | 'dire' | null = null
          if (typeof response.data?.result?.radiant_win === 'boolean') {
            winningTeam = response.data.result.radiant_win ? 'radiant' : 'dire'
          }

          if (winningTeam === null) {
            logger.info('Early dc match wont be scored bc winner is null', {
              name: this.getChannel(),
            })

            if (this.client.stream_online) {
              this.say(
                `Match not scored D: ${betsMessage}Not adding or removing MMR for match ${matchId}.`,
              )
            }
            this.resetClientState(true)
            return
          }

          logger.info('Should be scoring early dc here soon and closing predictions', {
            channel: this.getChannel(),
            winningTeam,
            matchId,
          })
          this.endBets(winningTeam)
        })
        .catch((e) => {
          try {
            // this could mean match is not over yet. just give up checking after this long (like 3m)
            // resetting vars will mean it will just grab it again on match load
            logger.error('early dc match didnt have data in it, match still going on?', {
              channel: this.getChannel(),
              matchId,
              e: e?.message || e?.result || e?.data || e,
            })

            this.resetClientState(true)
            return
          } catch (e) {
            logger.error(
              'caught an error in axios retry. likely server rebooted and channel was inaccessible',
            )
          }
        })

      return
    }

    const localWinner = winningTeam
    const myTeam = this.playingTeam ?? this.client.gsi?.player?.team_name
    const won = myTeam === localWinner
    logger.info('end bets won data', { localWinner, myTeam, won, channel: this.getChannel() })

    // Both or one undefined
    if (!myTeam) {
      logger.error('trying to end bets but did not find localWinner or myTeam', this.getChannel())
      return
    }

    logger.info('[BETS] Running end bets to award mmr and close predictions', {
      name: this.getChannel(),
      matchid: this.playingMatchId,
    })

    // this was used when endBets() was still in 'newdata' event called every 0.5s
    // TODO: remove endingBets and confirm if needed
    const channel = this.getChannel()
    this.endingBets = true

    logger.info('calling mmr update handler', {
      won,
      channel: this.getChannel(),
      matchId,
      heroSlot: this.playingHeroSlot,
    })

    // Default ranked
    const localLobbyType = typeof this.playingLobbyType !== 'number' ? 7 : this.playingLobbyType
    const isParty = false // sadge. opendota rate limited us
    this.updateMMR(won, localLobbyType, matchId, isParty, this.playingHeroSlot)

    if (!betsEnabled) {
      logger.info('bets are not enabled, stopping here', { name: this.getChannel() })

      this.resetClientState(true)
      return
    }

    if (!this.client.stream_online) {
      logger.info('[BETS] Not closing bets bc stream is offline for', { name: this.client.name })
      this.resetClientState(true)
      return
    }

    closeTwitchBet(won, this.getToken())
      .then(() => {
        logger.info('[BETS] end bets', {
          event: 'end_bets',
          data: {
            matchId: matchId,
            name: this.getChannel(),
            winning_team: localWinner,
            player_team: myTeam,
            didWin: won,
          },
        })
      })
      .catch((e: any) => {
        if (disabledBets.has(this.getToken())) {
          // disable the bet in settings for this user
          prisma.setting
            .upsert({
              where: {
                key_userId: {
                  key: DBSettings.bets,
                  userId: this.getToken(),
                },
              },
              create: {
                userId: this.getToken(),
                key: DBSettings.bets,
                value: false,
              },
              update: {
                value: false,
              },
            })
            .then((r) => {
              logger.info('[BETS] Disabled bets for user', {
                channel,
              })
              disabledBets.delete(this.getToken())
            })
            .catch((e) => {
              logger.info('[BETS] Error disabling bets', { e: e?.message || e })
            })
        } else {
          logger.info('[BETS] Error closing twitch bet', { channel, e: e?.message || e })
        }

        this.say(`We have ${won ? 'won' : 'lost'}`)
      })
      // Always
      .finally(() => {
        this.resetClientState(true)
      })
  }

  setupOBSBlockers(state?: string) {
    if (isSpectator(this.client.gsi)) {
      if (blockCache.get(this.getToken()) !== 'spectator') {
        this.emitBadgeUpdate()
        this.emitWLUpdate()

        server.io.to(this.getToken()).emit('block', { type: 'spectator' })
        blockCache.set(this.getToken(), 'spectator')
      }

      return
    }

    if (isArcade(this.client.gsi)) {
      if (blockCache.get(this.getToken()) !== 'arcade') {
        this.emitBadgeUpdate()
        this.emitWLUpdate()

        server.io.to(this.getToken()).emit('block', { type: 'arcade' })
        blockCache.set(this.getToken(), 'arcade')
      }

      return
    }

    // TODO: if the game is matchid 0 also dont show these? ie bot match. hero demo are type 'arcde'

    // Edge case:
    // Send strat screen if the player has picked their hero and it's locked in
    // Other players on their team could still be picking
    // -1 is the id of your hero if it gets ban picked when you pick first
    // the id is your hero if you pick last, and strategy screen is shown, but
    // the map state can still be hero selection
    // name is empty if your hero is not locked in
    if ((this.client.gsi?.hero?.id ?? -1) >= 0 && pickSates.includes(state ?? '')) {
      if (blockCache.get(this.getToken()) !== 'strategy') {
        server.io
          .to(this.getToken())
          .emit('block', { type: 'strategy', team: this.client.gsi?.player?.team_name })

        blockCache.set(this.getToken(), 'strategy')
      }

      return
    }

    // Check what needs to be blocked
    const hasValidBlocker = blockTypes.some((blocker) => {
      if (blocker.states.includes(state ?? '')) {
        // Only send if not already what it is
        if (blockCache.get(this.getToken()) !== blocker.type) {
          blockCache.set(this.getToken(), blocker.type)

          // Send the one blocker type
          server.io.to(this.getToken()).emit('block', {
            type: blocker.type,
            team: this.client.gsi?.player?.team_name,
          })

          if (blocker.type === 'playing') {
            this.emitBadgeUpdate()
            this.emitWLUpdate()
          }

          if (this.aegisPickedUp?.expireDate) {
            server.io.to(this.getToken()).emit('aegis-picked-up', this.aegisPickedUp)
          }

          if (this.roshanKilled?.maxDate) {
            server.io.to(this.getToken()).emit('roshan-killed', this.roshanKilled)
          }
        }
        return true
      }

      return false
    })

    // No blocker changes, don't emit any socket message
    if (!hasValidBlocker && !blockCache.has(this.getToken())) {
      return
    }

    // Unblock all, we are disconnected from the match
    if (!hasValidBlocker && blockCache.has(this.getToken())) {
      blockCache.delete(this.getToken())
      server.io.to(this.getToken()).emit('block', { type: null })
      this.endBets()
      return
    }
  }
}
