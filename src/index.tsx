import { $, Argv, Context, Schema } from 'koishi';
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
            .action(this.updateDatabase.bind(this));
        this.ctx.command('ninjutsu.clear', { authority: 4 })
            .alias('ninjutsu.\u6e05\u7a7a')
            .action(this.clearDatabase.bind(this));
        this.ctx.command('ninjutsu.info <name:text>')
            .alias('ninjutsu.\u4fe1\u606f')
            .action(this.getNinjutsuInfo.bind(this));
        this.ctx.command('ninjutsu.release <name:text>')
            .alias('ninjutsu.\u91ca\u653e', '\u91ca\u653e\u5fcd\u672f')
            .action(this.releaseNinjutsu.bind(this));
    }

    async updateDatabase({ session }: Argv) {
        let data = await this.ctx.http.get<NinjutsuSourceData>(`${this.cfg.sourceUrl}/api/jutsus`);
        let total = data.pagination.total;
        data = await this.ctx.http.get<NinjutsuSourceData>(`${this.cfg.sourceUrl}/api/jutsus?limit=${total}`);
        let upsert = data.jutsus.map(this.toNinjutsuInfo);
        await this.ctx.database.upsert('ninjutsu', upsert);
        this.ctx.emit('ninjutsu-database-update');
        return session.text('.completed', [total]);
    }

    async clearDatabase({ session }: Argv) {
        await this.ctx.database.remove('ninjutsu', { id: { $gt: 0 }});
        return session.text('.completed');
    }

    toNinjutsuInfo({ id, name, description }: NinjutsuInfoSourceData) {
        let nameNoPunctuation = removePunctuation(name);
        return { id, name, description, nameNoPunctuation };
    }

    async getNinjutsuInfo({ session }: Argv, name: string) {
        let ninjutsu = await this.tryGetNinjutsu(name);
        if(ninjutsu === undefined) {
            return session.text('.not-found');
        }
        return session.text('.info', {
            name: ninjutsu.name,
            description: ninjutsu.description,
            url: <a href={`${this.cfg.sourceUrl}/jutsus/${ninjutsu.id}`}>
                {session.text('.more-info')}
            </a>
        })
    }

    async releaseNinjutsu({ session }: Argv, name: string) {
        let ninjutsu = await this.tryGetNinjutsu(name);
        if(ninjutsu === undefined) {
            return session.text('.not-found');
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

    async tryGetNinjutsuAtLevel(name: string, matchLevel: LexNinjutsu.MatchLevel): Promise<NinjutsuInfo|undefined> {
        if(matchLevel === LexNinjutsu.MatchLevel.Homophone && !this.ctx.pinyin) {
            return undefined;
        }
        let target = {
            [LexNinjutsu.MatchLevel.Strict]: () => name,
            [LexNinjutsu.MatchLevel.Normal]: () => removePunctuation(name),
            [LexNinjutsu.MatchLevel.Homophone]: () => this.ctx.bail('get-pinyin', removePunctuation(name))
        }[matchLevel]();
        let property = {
            [LexNinjutsu.MatchLevel.Strict]: 'name',
            [LexNinjutsu.MatchLevel.Normal]: 'nameNoPunctuation',
            [LexNinjutsu.MatchLevel.Homophone]: 'namePinyin'
        }[matchLevel];
        let res = await this.ctx.database.select('ninjutsu')
            .where((row) => $.eq(row[property], target))
            .execute();
        return res[0];
    }

    async getNinjutsuAudios(id: number) {
        let url = `${this.cfg.sourceUrl}/api/jutsus/${id}/audios`;
        let data = await this.ctx.http.get<NinjutsuAudioSourceData>(url);
        return data.audios.map((info) => info.audioUrl);
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
        matchLevel: MatchLevel
    }

    export const Config: Schema<LexNinjutsu.Config> = Schema.object({
        sourceUrl: Schema.string().default('https://wsfrs.com/'),
        matchLevel: Schema.union([
            Schema.const(MatchLevel.Strict).description('strict'),
            Schema.const(MatchLevel.Normal).description('normal'),
            Schema.const(MatchLevel.Homophone).description('homophone')
        ]).default(MatchLevel.Normal).role('radio')
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
