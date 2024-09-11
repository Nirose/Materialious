(function () {
    "use strict";
    const R = "./ffmpeg-core.js";
    var E;
    (function (t) {
        t.LOAD = "LOAD", t.EXEC = "EXEC", t.WRITE_FILE = "WRITE_FILE", t.READ_FILE = "READ_FILE", t.DELETE_FILE = "DELETE_FILE", t.RENAME = "RENAME", t.CREATE_DIR = "CREATE_DIR", t.LIST_DIR = "LIST_DIR", t.DELETE_DIR = "DELETE_DIR", t.ERROR = "ERROR", t.DOWNLOAD = "DOWNLOAD", t.PROGRESS = "PROGRESS", t.LOG = "LOG", t.MOUNT = "MOUNT", t.UNMOUNT = "UNMOUNT"
    })(E || (E = {}));
    const a = new Error("unknown message type"),
        f = new Error("ffmpeg is not loaded, call `await ffmpeg.load()` first"),
        u = new Error("failed to import ffmpeg-core.js");
    let r;
    const O = async ({
        coreURL: t,
        wasmURL: n,
        workerURL: e
    }) => {
        const o = !r;
        try {
            t || (t = R), importScripts(t)
        } catch {
            if (t || (t = R.replace("/umd/", "/esm/")), self.createFFmpegCore = (await import(t)).default, !self.createFFmpegCore) throw u
        }
        const s = t,
            c = n || t.replace(/.js$/g, ".wasm"),
            b = e || t.replace(/.js$/g, ".worker.js");
        return r = await self.createFFmpegCore({
            mainScriptUrlOrBlob: `${s}#${btoa(JSON.stringify({ wasmURL: c, workerURL: b }))}`
        }), r.setLogger(i => self.postMessage({
            type: E.LOG,
            data: i
        })), r.setProgress(i => self.postMessage({
            type: E.PROGRESS,
            data: i
        })), o
    }, l = ({
        args: t,
        timeout: n = -1
    }) => {
        r.setTimeout(n), r.exec(...t);
        const e = r.ret;
        return r.reset(), e
    }, m = ({
        path: t,
        data: n
    }) => (r.FS.writeFile(t, n), !0), D = ({
        path: t,
        encoding: n
    }) => r.FS.readFile(t, {
        encoding: n
    }), S = ({
        path: t
    }) => (r.FS.unlink(t), !0), I = ({
        oldPath: t,
        newPath: n
    }) => (r.FS.rename(t, n), !0), L = ({
        path: t
    }) => (r.FS.mkdir(t), !0), N = ({
        path: t
    }) => {
        const n = r.FS.readdir(t),
            e = [];
        for (const o of n) {
            const s = r.FS.stat(`${t}/${o}`),
                c = r.FS.isDir(s.mode);
            e.push({
                name: o,
                isDir: c
            })
        }
        return e
    }, A = ({
        path: t
    }) => (r.FS.rmdir(t), !0), w = ({
        fsType: t,
        options: n,
        mountPoint: e
    }) => {
        const o = t,
            s = r.FS.filesystems[o];
        return s ? (r.FS.mount(s, n, e), !0) : !1
    }, k = ({
        mountPoint: t
    }) => (r.FS.unmount(t), !0);
    self.onmessage = async ({
        data: {
            id: t,
            type: n,
            data: e
        }
    }) => {
        const o = [];
        let s;
        try {
            if (n !== E.LOAD && !r) throw f;
            switch (n) {
                case E.LOAD:
                    s = await O(e);
                    break;
                case E.EXEC:
                    s = l(e);
                    break;
                case E.WRITE_FILE:
                    s = m(e);
                    break;
                case E.READ_FILE:
                    s = D(e);
                    break;
                case E.DELETE_FILE:
                    s = S(e);
                    break;
                case E.RENAME:
                    s = I(e);
                    break;
                case E.CREATE_DIR:
                    s = L(e);
                    break;
                case E.LIST_DIR:
                    s = N(e);
                    break;
                case E.DELETE_DIR:
                    s = A(e);
                    break;
                case E.MOUNT:
                    s = w(e);
                    break;
                case E.UNMOUNT:
                    s = k(e);
                    break;
                default:
                    throw a
            }
        } catch (c) {
            self.postMessage({
                id: t,
                type: E.ERROR,
                data: c.toString()
            });
            return
        }
        s instanceof Uint8Array && o.push(s.buffer), self.postMessage({
            id: t,
            type: n,
            data: s
        }, o)
    }
})();