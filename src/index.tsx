import { $, Context, Schema, Session } from 'koishi';
import NinjutsuPinyin from './pinyin';

declare module 'koishi' {
    interface Tables {
        ninjutsu: NinjutsuInfo
    }

    interface Events {
        'ninjutsu-database-update'(): void,
        'get-pinyin'(s: string): string
    }

}

interface NinjutsuInfo {
    id: number,
    name: string,
    description: string
    nameNoPunctuation: string,
    namePinyin: string
}

class LexNinjutsu {

    readonly ctx: Context;
    readonly cfg: LexNinjutsu.Config;

    constructor(ctx: Context, cfg: LexNinjutsu.Config) {
        this.ctx = ctx;
        this.cfg = cfg
        ctx.i18n.define('zh-CN', require('./locales/zh-CN.json'));
        this.initDatabase();
        this.initCommands();
        ctx.plugin(NinjutsuPinyin);
    }

    initDatabase() {
        this.ctx.model.extend('ninjutsu', {
            id: 'unsigned',
            name: 'string',
            description: 'string',
            nameNoPunctuation: 'string',
            namePinyin: 'string'
        })
    }

    initCommands() {
        this.ctx.command('ninjutsu').alias('\u5fcd\u672f');
        this.ctx.command('ninjutsu.update', { authority: 3 })
            .alias('ninjutsu.\u66f4\u65b0')
            .action(({ session }) => this.updateDatabase(session));
        this.ctx.command('ninjutsu.clear', { authority: 4 })
            .alias('ninjutsu.\u6e05\u7a7a')
            .action(({ session }) => this.clearDatabase(session));
        this.ctx.command('ninjutsu.info <name:text>')
            .alias('ninjutsu.\u4fe1\u606f')
            .action(({ session }, name) => this.getNinjutsuInfo(session, name));
        this.ctx.command('ninjutsu.release <name:text>')
            .alias('ninjutsu.\u91ca\u653e', '\u91ca\u653e\u5fcd\u672f')
            .action(({ session }, name) => this.releaseNinjutsu(session, name));
        this.ctx.command('ninjutsu.search <keyword:text>')
            .alias('ninjutsu.\u641c\u7d22')
            .option('limit', '-l [limit:number]')
            .action(({ session, options }, keyword) => this.searchNinjutsu(session, options.limit, keyword));
    }

    // MARK: ninjutsu.update
    async updateDatabase(session: Session) {
        let data = await this.ctx.http.get<NinjutsuSourceData>(`${this.cfg.sourceUrl}/api/jutsus`);
        let total = data.pagination.total;
        data = await this.ctx.http.get<NinjutsuSourceData>(`${this.cfg.sourceUrl}/api/jutsus?limit=${total}`);
        let upsert = data.jutsus.map(this.toNinjutsuInfo);
        await this.ctx.database.upsert('ninjutsu', upsert);
        this.ctx.emit('ninjutsu-database-update');
        return session.text('.completed', [total]);
    }

    toNinjutsuInfo({ id, name, description }: NinjutsuInfoSourceData) {
        let nameNoPunctuation = removePunctuation(name);
        return { id, name, description, nameNoPunctuation };
    }

    // MARK: ninjutsu.clear
    async clearDatabase(session: Session) {
        await this.ctx.database.remove('ninjutsu', { id: { $gt: 0 }});
        return session.text('.completed');
    }

    // MARK: ninjutsu.info
    async getNinjutsuInfo(session: Session, name: string) {
        let ninjutsu = await this.tryGetNinjutsu(name);
        if(ninjutsu === undefined) {
            return await this.onNotfound(session, name);
        }
        return session.text('.info', {
            name: ninjutsu.name,
            description: ninjutsu.description,
            url: `${this.cfg.sourceUrl}/jutsus/${ninjutsu.id}`
        })
    }

    // MARK: ninjutsu.release
    async releaseNinjutsu(session: Session, name: string) {
        let ninjutsu = await this.tryGetNinjutsu(name);
        if(ninjutsu === undefined) {
            return await this.onNotfound(session, name);
        }
        let audios = await this.getNinjutsuAudios(ninjutsu.id);
        if(!audios.length) {
            return session.text('.no-audio');
        }
        let index = Math.floor(Math.random() * audios.length);
        let audio = audios[index];
        return <audio src={audio}/>;
    }

    async tryGetNinjutsu(name: string): Promise<NinjutsuInfo|undefined> {
        for(let level=LexNinjutsu.MatchLevel.Strict; level<=this.cfg.matchLevel; level++) {
            let ninjutsu = await this.tryGetNinjutsuAtLevel(name, level);
            if(ninjutsu) {
                return ninjutsu;
            }
        }
        return undefined;
    }

    async onNotfound(session: Session, name: string) {
        if(!this.cfg.searchOnFailed) {
            return session.text('.not-found');
        }
        await session.sendQueued(session.text('.not-found-try-search'));
        return session.execute(`ninjutsu.search ${name}`);
    }

    async tryGetNinjutsuAtLevel(name: string, matchLevel: LexNinjutsu.MatchLevel): Promise<NinjutsuInfo|undefined> {
        let { getKeyword, propertyName } = this.getMatchInfo(matchLevel);
        let keyword = getKeyword(name);
        let res = await this.ctx.database.select('ninjutsu')
            .where((row) => $.eq(row[propertyName], keyword))
            .execute();
        return res[0];
    }

    async getNinjutsuAudios(id: number) {
        let url = `${this.cfg.sourceUrl}/api/jutsus/${id}/audios`;
        let data = await this.ctx.http.get<NinjutsuAudioSourceData>(url);
        return data.audios.map((info) => info.audioUrl);
    }

    // MARK: ninjutsu.search
    async searchNinjutsu(session: Session, limit: number|undefined, keyword: string) {
        limit ??= this.cfg.searchLimit;
        let res: { [id: number]: NinjutsuInfo } = {};
        let prev = res;
        for(let level=LexNinjutsu.MatchLevel.Strict; level<=this.cfg.matchLevel; level++) {
            let ninjutsus = await this.searchNinjutsuAtLevel(keyword, limit, level);
            let cur: typeof res = {};
            for(let ninjutsu of ninjutsus) {
                cur[ninjutsu.id] = ninjutsu;
            }
            Object.setPrototypeOf(prev, cur);
            prev = cur;
        }
        let count = 0;
        let message = '';
        for(let id in res) {
            let ninjutsu = res[id];
            count++;
            if(count > limit) {
                continue;
            }
            let item = session.text('.result-item', {
                name: ninjutsu.name,
                description: this.getDescriptionPreview(ninjutsu.description)
            });
            message += '\n' + item;
        }
        if(!count) {
            return session.text('.no-result');
        }
        return session.text('.result-title') + message;
    }

    async searchNinjutsuAtLevel(name: string, limit: number, matchLevel: LexNinjutsu.MatchLevel) {
        let { getKeyword, propertyName } = this.getMatchInfo(matchLevel);
        let keyword = getKeyword(name);
        let res = await this.ctx.database.select('ninjutsu')
            .where((row) => $.regex(row[propertyName], new RegExp(`.*${keyword}.*`)))
            .limit(limit)
            .execute();
        console.log(res);
        return res;
    }

    getDescriptionPreview(description: string) {
        let limit = this.cfg.descriptionPreviewLimit;
        if(!limit) {
            return description
        }
        description = description.replaceAll('\n', ' ');
        if(description.length <= limit) {
            return description
        }
        return description.substring(0, limit) + '\u2026';
    }

    getMatchInfo(matchLevel: LexNinjutsu.MatchLevel) {
        if(matchLevel === LexNinjutsu.MatchLevel.Homophone && !this.ctx.pinyin) {
            matchLevel = LexNinjutsu.MatchLevel.Normal;
        }
        let getKeyword = {
            [LexNinjutsu.MatchLevel.Strict]: (name: string) => name,
            [LexNinjutsu.MatchLevel.Normal]: (name: string) => removePunctuation(name),
            [LexNinjutsu.MatchLevel.Homophone]: (name: string) => this.ctx.bail('get-pinyin', removePunctuation(name))
        }[matchLevel];
        let propertyName = {
            [LexNinjutsu.MatchLevel.Strict]: 'name',
            [LexNinjutsu.MatchLevel.Normal]: 'nameNoPunctuation',
            [LexNinjutsu.MatchLevel.Homophone]: 'namePinyin'
        }[matchLevel];
        return { getKeyword, propertyName };
    }

}

namespace LexNinjutsu {

    export const inject = {
        'required': ['database', 'http'],
        'optional': ['pinyin']
    };

    export enum MatchLevel {
        Strict, Normal, Homophone
    }

    export interface Config {
        sourceUrl: string,
        matchLevel: MatchLevel,
        searchLimit: number,
        descriptionPreviewLimit: number,
        searchOnFailed: boolean
    }

    export const Config: Schema<LexNinjutsu.Config> = Schema.object({
        sourceUrl: Schema.string().default('https://wsfrs.com/'),
        matchLevel: Schema.union([
            Schema.const(MatchLevel.Strict).description('strict'),
            Schema.const(MatchLevel.Normal).description('normal'),
            Schema.const(MatchLevel.Homophone).description('homophone')
        ]).default(MatchLevel.Normal).role('radio'),
        searchLimit: Schema.number().min(1).step(1).default(10),
        descriptionPreviewLimit: Schema.number().min(0).step(1).default(10),
        searchOnFailed: Schema.boolean().default(true)
    }).i18n({
        'zh-CN': require('./locales/zh-CN.json')._config
    });
}

export default LexNinjutsu;

type NinjutsuSourceData = {
    jutsus: NinjutsuInfoSourceData[],
    pagination: {
        total: number,
    }
}

type NinjutsuInfoSourceData = {
    id: number,
    name: string,
    description: string
}

type NinjutsuAudioSourceData = {
    audios: {
        audioUrl: string
    }[]
}

function removePunctuation(s: string) {
    return s.replaceAll(/\p{P}|\p{S}|\p{Z}/ug, '');
}
