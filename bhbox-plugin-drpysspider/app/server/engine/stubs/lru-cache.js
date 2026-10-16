// lru-cache 精简替代：Map + TTL + dispose（引擎只用到 has/get/set/delete/clear）
export class LRUCache {
    constructor(options = {}) {
        this.max = options.max || 500;
        this.ttl = options.ttl || 0;
        this.dispose = options.dispose;
        this.map = new Map();
    }

    has(key) {
        if (!this.map.has(key)) return false;
        if (this._expired(key)) {
            this.delete(key);
            return false;
        }
        return true;
    }

    get(key) {
        if (!this.map.has(key)) return undefined;
        if (this._expired(key)) {
            this.delete(key);
            return undefined;
        }
        const value = this.map.get(key).value;
        // LRU 触达移到最新位
        this.map.delete(key);
        this.map.set(key, {value, expire: this._expireAt()});
        return value;
    }

    set(key, value) {
        if (this.map.has(key)) this.map.delete(key);
        this.map.set(key, {value, expire: this._expireAt()});
        if (this.map.size > this.max) {
            const oldKey = this.map.keys().next().value;
            this.delete(oldKey);
        }
        return this;
    }

    delete(key) {
        const entry = this.map.get(key);
        const deleted = this.map.delete(key);
        if (deleted && this.dispose && entry) {
            try { this.dispose(entry.value); } catch (e) {}
        }
        return deleted;
    }

    clear() {
        if (this.dispose) {
            for (const entry of this.map.values()) {
                try { this.dispose(entry.value); } catch (e) {}
            }
        }
        this.map.clear();
    }

    _expireAt() {
        return this.ttl ? Date.now() + this.ttl : 0;
    }

    _expired(key) {
        const expire = this.map.get(key).expire;
        return expire !== 0 && Date.now() > expire;
    }
}

export default LRUCache;
