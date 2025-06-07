import { $, Context } from 'koishi';
import {} from 'koishi-plugin-pinyin';

class NinjutsuPinyin {

    ctx: Context

    constructor(ctx: Context) {
        this.ctx = ctx;
        ctx.on('ready', this.updateDatabasePinyin.bind(this));
        ctx.on('ninjutsu-database-update', this.updateDatabasePinyin.bind(this))
        ctx.on('get-pinyin', this.getPinyin.bind(this));
    }

    async updateDatabasePinyin() {
        let data = await this.ctx.database.select('ninjutsu')
            .where((row) => $.eq(row.namePinyin, ''))
            .execute();
        data.forEach((info) => info.namePinyin = this.ctx.bail('get-pinyin', info.nameNoPunctuation));
        await this.ctx.database.upsert('ninjutsu', data);
    }

    getPinyin(s: string) {
        return this.ctx.pinyin.pinyin(s, { style: 0 }).join('').toLowerCase();
    }

}

namespace NinjutsuPinyin {

    export const inject = ['pinyin'];

}

export default NinjutsuPinyin;
