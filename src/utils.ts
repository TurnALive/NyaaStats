/// <reference types="../types/minecraft" />
/// <reference types="../types/nyaa-stats" />

import fs from 'fs-extra'
import path from 'path'
import axios from 'axios'
import NBT from 'mcnbt'

import loadConfig from './config'
import {defaultSkin, delay, download, mergeStats, writeJSON} from './helper'
import * as logger from './logger'

const config = loadConfig()
let official = true

export default class Utils {
  apiLimited: boolean

  constructor () {
    this.apiLimited = false
  }

  getWorldTime (): Promise<number> {
    const nbt = new NBT()
    return new Promise((resolve, reject) => {
      nbt.loadFromZlibCompressedFile(
        path.join(config.get<string>('render.level')),
        (err) => {
          if (err) return reject(err)
          return resolve(Number(BigInt(nbt.select('').select('Data').select('Time').getValue())) / 20)
        },
      )
    })
  }

  getAllPlayers (): LongUuid[] {
    const uuids: LongUuid[] = []
    const r = new RegExp(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
    fs.readdirSync(path.join(config.get<string>('render.playerdata'))).forEach((f) => {
      const uuid = path.basename(f, '.dat')
      // filter out old player usernames.
      if (r.test(uuid)) {
        uuids.push(uuid)
      }
    })
    return uuids
  }

  getWhitelistedPlayers (): LongUuid[] {
    const uuids: LongUuid[] = []
    JSON.parse(fs.readFileSync(config.get<string>('render.whitelist'), 'utf8')).forEach((p: McWhitelistRecord) => {
      uuids.push(p.uuid)
    })
    return uuids
  }

  getBannedPlayers (): LongUuid[] {
    const banlist: LongUuid[] = []
    const banned = JSON.parse(fs.readFileSync(path.join(config.get<string>('render.banned-players')), 'utf8')) as McBannedPlayersJson
    banned.forEach((ban) => {
      banlist.push(ban.uuid)
    })
    return banlist
  }

  getPlayerState (uuid: LongUuid): Promise<{merged: McPlayerStatsJson, source: McPlayerStatsJson}> {
    return new Promise((resolve, reject) => {
      if (!config.get('render.stats')) return reject()
      const statsfile = path.join(config.get<string>('render.stats'), `${uuid}.json`)
      let data: string | McPlayerStatsJson
      try {
        data = fs.readFileSync(statsfile, 'utf-8') as string
        logger.PlayerData.info('READ', statsfile)
        data = JSON.parse(data) as McPlayerStatsJson
        return resolve({
          merged: mergeStats(data),
          source: data,
        })
      } catch (error) {
        logger.PlayerData.warn('READ', statsfile, JSON.stringify(error))
        return resolve({merged: {}, source: {}})
      }
    })
  }

  getPlayerAdvancements (uuid: LongUuid): Promise<McPlayerAdvancementsJson> {
    return new Promise((resolve, reject) => {
      // compatible to 1.11
      if (!config.get('render.advancements')) return reject()
      const advancementsfile = path.join(config.get<string>('render.advancements'), `${uuid}.json`)

      let data: string
      try {
        data = fs.readFileSync(advancementsfile, 'utf-8') as string
        logger.PlayerData.info('READ', advancementsfile)
        return resolve(JSON.parse(data))
      } catch (error) {
        logger.PlayerData.warn('READ', advancementsfile, JSON.stringify(error))
        return resolve({})
      }
    })
  }

  getPlayerData (uuid: LongUuid): Promise<NSPlayerInfoData> {
    const datafile = path.join(config.get<string>('render.playerdata'), `${uuid}.dat`)
    return new Promise((resolve, reject) => {
      const nbt = new NBT()
      nbt.loadFromZlibCompressedFile(datafile, async (err) => {
        if (err) {
          logger.PlayerData.warn('READ', datafile, err)
          return reject()
        }
        logger.PlayerData.info('READ', datafile)
        const uuidShort = uuid.replace(/-/g, '')
        let history
        try {
          history = official?await this.getNameHistory(uuidShort):await this.getYggName(uuidShort)
        } catch (error) {
          return reject()
        }
        if (history && history[0]) {
          let lived: number | undefined
          if (nbt.select('').select('Spigot.ticksLived')) {
            lived = (nbt.select('').select('Spigot.ticksLived').getValue() as number) / 20
          }
          const timeStart = nbt.select('').select('bukkit')
            ? Number(BigInt(nbt.select('').select('bukkit').select('firstPlayed').getValue()))
            : undefined
          const timeLast = nbt.select('').select('bukkit')
            ? Number(BigInt(nbt.select('').select('bukkit').select('lastPlayed').getValue()))
            : undefined
          const pdata: NSPlayerInfoData = {
            seen: timeLast,
            time_start: timeStart,
            time_last: timeLast,
            time_lived: lived,
            playername: history[0].name,
            names: history,
            uuid_short: uuidShort,
            lastUpdate: (new Date()).valueOf(),
            uuid,
          }
          return resolve(pdata)
        }
        return reject()
      })
    })
  }

  async getPlayerTotalData (uuid: LongUuid): Promise<NSPlayerStatsJson | null> {
    let s
    let stats
    let stats_source
    let advancements
    let data
    try {
      s = await this.getPlayerState(uuid)
      stats = s['merged']
      stats_source = s['source']
      advancements = await this.getPlayerAdvancements(uuid)
      data = await this.getPlayerData(uuid)
    } catch (error) {
      return null
    }
    return {
      stats,
      stats_source,
      advancements,
      data,
    }
  }

  async getNameHistory (uuid: LongUuid): Promise<McNameHistory | null> {
    const apiNameHistory = `https://api.mojang.com/user/profiles/${uuid}/names`
    let history
    try {
      history = await this.getMojangAPI<McNameHistory>(apiNameHistory)
    } catch (err) {
      return null
    }
    if (!history) return null
    // The order of the response data from Mojang API is uncertain,
    // so manually sort it (to descending order) for making sure.
    history.sort((a, b) => (b.changedToAt || 0) - (a.changedToAt || 0))
    return history
  }

  async getYggName (uuid: LongUuid): Promise<McNameHistory | null>  {
    const apiYggName = `${config.get('render.ygg-profile')}/${uuid}`
    let yggName: string
    try {
      yggName = await this.getYggAPI(apiYggName)
    } catch (err) {
      return null
    }
    if (!yggName) return null
    return this.typeConvert(yggName)
  }

  async getYggAPI (apiPath: string): Promise<string> {
    if (config.get('api.ratelimit') && this.apiLimited) {
      await delay(10)
      return this.getYggAPI(apiPath)
    }
    this.apiLimited = true
    logger.YggAPI.info('REQUEST', apiPath)

    let body
    try {
      const res = await axios.get(apiPath, {timeout: 30000})
      body=res.data
    } catch (err) {
      logger.YggAPI.error('REQUEST', apiPath, err.toJSON())
      setTimeout(() => {
        this.apiLimited = false
      }, config.get<number>('api.ratelimit') * 3000)
      throw new Error(err.toJSON())
    }

    setTimeout(() => {
      this.apiLimited = false
    }, config.get<number>('api.ratelimit') * 1000)
    
    return body.name
  }

  async getMojangAPI <T> (apiPath: string): Promise<T> {
    if (config.get('api.ratelimit') && this.apiLimited) {
      await delay(10)
      return this.getMojangAPI(apiPath)
    }
    this.apiLimited = true
    logger.MojangAPI.info('REQUEST', apiPath)

    let body
    try {
      const res = await axios.get(apiPath, {timeout: 30000})
      body = res.data
    } catch (err) {
      logger.MojangAPI.error('REQUEST', apiPath, err.toJSON())
      setTimeout(() => {
        this.apiLimited = false
      }, config.get<number>('api.ratelimit') * 3000)
      throw new Error(err.toJSON())
    }

    setTimeout(() => {
      this.apiLimited = false
    }, config.get<number>('api.ratelimit') * 1000)

    return body
  }

  async getPlayerAssets (uuid: LongUuid, playerpath: string): Promise<void> {
    try {
      fs.ensureDirSync(playerpath)
    } catch (error) {
      throw new Error(error)
    }

    const apiPrefixAvatar = official?`${config.get('render.crafatar')}/avatars/`:`${config.get('render.ygg-crafatar')}/avatars/`
    const apiPrefixBody = official?`${config.get('render.crafatar')}/renders/body/`:`${config.get('render.ygg-crafatar')}/renders/body/`
    const apiPrefixSkin = official?`${config.get('render.crafatar')}/skins/`:`${config.get('render.ygg-crafatar')}/skins/`

    const slim = `&default=MHF_${defaultSkin(uuid)}`

    await download(
      `${apiPrefixAvatar}${uuid}?size=64&overlay${slim}`,
      path.join(playerpath, 'avatar.png'),
    )
    await download(
      `${apiPrefixBody}${uuid}?size=128&overlay${slim}`,
      path.join(playerpath, 'body.png'),
    )
    await download(
      `${apiPrefixSkin}${uuid}?${slim}`,
      path.join(playerpath, 'skin.png'),
    )
  }

  async checkOfficial (uuid: LongUuid): Promise<boolean> {
    const apiNameHistory = `https://api.mojang.com/user/profiles/${uuid}/names`
    const apiYggName = `${config.get('render.ygg-profile')}/${uuid}`
    let history
    try {
      history = await this.getMojangAPI<McNameHistory>(apiNameHistory)
      if(history) return true
    } catch (err) {
      throw new Error(err)
    }
    if (!history) {
      try {
        history = await this.getYggAPI(apiYggName)
        if(history) return false
      } catch (err) {
        throw new Error(err)
      }
    }
    throw new Error()
  }

  async typeConvert (history: string): Promise<McNameHistory | null> {
    const result:McNameHistory = [{name:history}]
    return result
  }

  async createPlayerData (uuid: LongUuid, banned = false): Promise<NSPlayerStatsJson> {
    try {
      official = await this.checkOfficial(uuid.replace(/-/g, ''))
    } catch (error) {
      logger.PlayerData.error('Player Not Found in neither Mojang nor Yggdrasil API.')
      throw new Error(error)
    }
    const playerpath = path.join(config.get<string>('render.output'), uuid.replace(/-/g, ''))
    let data
    try {
      if (fs.existsSync(path.join(playerpath, 'stats.json'))) {
        data = JSON.parse(fs.readFileSync(path.join(playerpath, 'stats.json'), 'utf-8'))
      } else {
        data = await this.getPlayerTotalData(uuid)
      }
    } catch (error) {
      throw new Error(error)
    }
    if (fs.existsSync(path.join(playerpath, 'avatar.png') && path.join(playerpath, 'body.png'))) {
      return data
    } else if (data && data.stats && data.data) {
      try {
        await this.getPlayerAssets(uuid.replace(/-/g, ''), playerpath)
      } catch (error) {
        logger.PlayerData.error('ASSETS', error)
      }
      data.data = {
        ...data.data,
        banned,
      }
      writeJSON(path.join(playerpath, 'stats.json'), data as never)
      return data
    }
    throw new Error()
  }
}
