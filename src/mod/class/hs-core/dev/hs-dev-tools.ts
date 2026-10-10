import { HSGlobal } from "../hs-global";
import { HSLogger } from "../hs-logger";
import { HSStorage } from "../hs-storage";
import { HSUI } from "../hs-ui";
import { HSGameData } from "../gds/hs-gamedata";
import { HSModuleManager } from "../module/hs-module-manager";
import devToolsCSS from "inline:../../../resource/css/module/hs-dev-tools.css";

type HSDevValueKind = 'number' | 'decimal' | 'quarks' | 'cube' | 'boolean' | 'string';

interface HSDevRowDefinition {
    label: string;
    // Path into the player object, e.g. "hepteracts.quark.BAL"
    path: string;
    // Amounts get a suggested value (5 exponents above the current one); levels and counts don't
    suggest: boolean;
    pinned?: boolean;
}

interface HSDevRow {
    def: HSDevRowDefinition;
    current: HTMLElement;
    input: HTMLInputElement;
}

interface HSDevLeaf {
    parent: any;
    key: string;
    value: unknown;
    kind: HSDevValueKind;
}

interface HSDevStoredData {
    pinned: string[];
    freePath: string;
}

interface HSDevSnapshot {
    id?: number;
    kind: 'auto' | 'named';
    date: number;
    label: string;
    // The save as the game serializes it (JSON, before its base64 encoding)
    save: string;
}

const STORAGE_KEY = 'dev-tools';
const SNAPSHOT_DB = 'hs-dev-tools';
const SNAPSHOT_STORE = 'snapshots';
const AUTO_SNAPSHOTS_KEPT = 5;
const REFRESH_MS = 500;
const SUGGESTION_EXPONENT_STEP = 5;
// The game caps cubes at 1e300, and a plain number ends at 1.8e308
const MAX_NUMBER_EXPONENT = 300;
const NUMERIC_INPUT = /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i;

const ROW_GROUPS: { title: string, rows: HSDevRowDefinition[] }[] = [
    {
        title: 'Resources',
        rows: [
            { label: 'Quarks', path: 'worlds', suggest: true },
            { label: 'Golden Quarks', path: 'goldenQuarks', suggest: true },
            { label: 'Wow Cubes', path: 'wowCubes', suggest: true },
            { label: 'Tesseracts', path: 'wowTesseracts', suggest: true },
            { label: 'Hypercubes', path: 'wowHypercubes', suggest: true },
            { label: 'Platonic Cubes', path: 'wowPlatonicCubes', suggest: true },
            { label: 'Hepteracts', path: 'wowAbyssals', suggest: true },
            { label: 'Octeracts', path: 'wowOcteracts', suggest: true },
        ]
    },
    {
        title: 'Ambrosia',
        rows: [
            { label: 'Ambrosia', path: 'ambrosia', suggest: true },
            { label: 'Lifetime Ambrosia', path: 'lifetimeAmbrosia', suggest: true },
            { label: 'Red Ambrosia', path: 'redAmbrosia', suggest: true },
            { label: 'Lifetime Red Ambrosia', path: 'lifetimeRedAmbrosia', suggest: true },
        ]
    },
    {
        title: 'Other',
        rows: [
            { label: 'Cx11 level (0 to 100)', path: 'cubeUpgrades.61', suggest: false },
        ]
    },
];

/**
 * Class: HSDevTools
 * IsExplicitHSModule: No
 * Description:
 *     Dev builds only: rows on the Debug tab that edit the live player object (quarks, cubes, hepteracts,
 *     ambrosia, any field by path), to set up a save for a test.
 *     Never reaches players: its only use is under `if (HS_DEV_BUILD)`, a build-time constant that is false
 *     in the release build, so esbuild drops this file from the release bundle (the release build checks it).
 *     For that to hold, keep this class free of static fields and of imports that run code when loaded.
 * Author: maenhiir
 */
export class HSDevTools {
    #context = 'HSDevTools';

    #root?: HTMLElement;
    #rows: HSDevRow[] = [];
    #pinnedHolder?: HTMLElement;
    #snapshotStatus?: HTMLElement;
    #freePath?: HTMLInputElement;
    #freeCurrent?: HTMLElement;

    #data: HSDevStoredData = { pinned: [], freePath: '' };

    // Taken before the first edit of the session (a page load)
    #sessionSnapshot?: HSDevSnapshot;
    // The player chose to edit without a snapshot, after the capture failed
    #snapshotWaived = false;

    /** Adds the dev tools at the end of the Debug tab's grid. */
    build(parent: HTMLElement): void {
        this.#loadData();
        HSUI.injectStyle(devToolsCSS, 'hs-dev-tools-css');

        const root = this.#el('div', 'hs-panel-grid-full-span');
        root.id = 'hs-dev-tools';
        this.#root = root;

        root.append(this.#el('div', 'hs-panel-grid-section-header', 'Dev tools (dev build only)'));
        root.append(this.#buildSnapshotStatus());

        if (!HSGlobal.exposedPlayer) {
            root.append(this.#el('div', '', 'No player object: these tools need the patched game.'));
            parent.append(root);
            return;
        }

        const hepteractRows: HSDevRowDefinition[] = [];
        for (const craft of Object.keys(HSGlobal.exposedPlayer.hepteracts ?? {})) {
            hepteractRows.push({ label: `${craft}: balance`, path: `hepteracts.${craft}.BAL`, suggest: true });
            hepteractRows.push({ label: `${craft}: cap expansions`, path: `hepteracts.${craft}.TIMES_CAP_EXTENDED`, suggest: false });
        }

        const groups = [...ROW_GROUPS];
        groups.splice(1, 0, { title: 'Hepteract crafts (each cap expansion doubles the cap)', rows: hepteractRows });
        for (const group of groups) {
            root.append(this.#el('div', 'hs-dev-tools-group', group.title));
            for (const def of group.rows) root.append(this.#buildRow(def));
        }

        root.append(this.#el('div', 'hs-dev-tools-group', 'Code timers'));
        const timers = this.#el('div', 'hs-dev-tools-buttons');
        timers.append(
            this.#button('Reset Add code timer', () => this.set('rngCode', '0', 'Add code timer')),
            this.#button('Reset Time code timer', () => this.set('promoCodeTiming.time', '0', 'Time code timer')),
        );
        root.append(timers);

        root.append(this.#el('div', 'hs-dev-tools-group', 'Any player field (path, then value)'));
        root.append(this.#buildFreeRow());

        this.#pinnedHolder = this.#el('div', '');
        root.append(this.#pinnedHolder);
        this.#renderPinnedRows();

        parent.append(root);

        // Same edits from the console, so a test list can give a one-liner
        (window as any).hsDev = {
            get: (path: string) => {
                const leaf = this.#resolve(path);
                return typeof leaf === 'string' ? leaf : leaf.value;
            },
            set: (path: string, value: unknown) => this.set(path, String(value)),
        };

        this.#refresh();
        window.setInterval(() => this.#refresh(), REFRESH_MS);
    }

    /**
     * Writes a value into the player object. Refused when the path doesn't lead to an existing single value,
     * so a typo can't create a field. The first edit of the session takes a snapshot of the save first.
     */
    set(path: string, text: string, label = path): boolean {
        const value = text.trim();
        if (value === '') return this.#fail('Type a value first');

        const leaf = this.#resolve(path);
        if (typeof leaf === 'string') return this.#fail(leaf);
        if (!this.#ensureSnapshot()) return false;

        const before = this.#format(leaf);
        const error = this.#write(leaf, value);
        if (error) return this.#fail(error);

        const after = this.#resolve(path);
        HSLogger.log(`${label}: ${before} -> ${typeof after === 'string' ? '?' : this.#format(after)}`, this.#context);
        this.#refresh();
        return true;
    }

    #fail(message: string): false {
        HSLogger.warn(message, this.#context);
        void HSUI.Notify(message, { notificationType: 'error' });
        return false;
    }

    // ===================================
    // --- Reading and writing values ----
    // ===================================

    #normalizePath(path: string): string {
        const keys = path.trim().replace(/\[(\w+)\]/g, '.$1').split('.').filter(key => key !== '');
        if (keys[0] === 'player') keys.shift();
        return keys.join('.');
    }

    /** The value at the end of a path, with what holds it, or the reason why there's none. */
    #resolve(path: string): HSDevLeaf | string {
        const player = HSGlobal.exposedPlayer;
        if (!player) return 'No player object: the game is not patched';

        const keys = this.#normalizePath(path).split('.');
        if (keys[0] === '') return 'Empty path';

        // Own properties only, so "constructor" or "__proto__" lead nowhere
        const has = (holder: object, key: string) => Object.prototype.hasOwnProperty.call(holder, key);

        let parent: any = player;
        for (let i = 0; i < keys.length - 1; i++) {
            const next = has(parent, keys[i]) ? parent[keys[i]] : undefined;
            if (next === null || typeof next !== 'object') return `No object at "${keys.slice(0, i + 1).join('.')}"`;
            parent = next;
        }

        const key = keys[keys.length - 1];
        if (!has(parent, key)) return `No field "${keys.join('.')}"`;

        const value = parent[key];
        const kind = this.#kindOf(value);
        if (!kind) return `"${keys.join('.')}" is not a single value`;

        return { parent, key, value, kind };
    }

    #kindOf(value: unknown): HSDevValueKind | null {
        if (typeof value === 'number') return 'number';
        if (typeof value === 'boolean') return 'boolean';
        if (typeof value === 'string') return 'string';
        if (value === null || typeof value !== 'object') return null;

        const holder = value as any;
        // The game's Decimal (coins, offerings, obtainium...)
        if (typeof holder.mantissa === 'number' && typeof holder.exponent === 'number') return 'decimal';
        // The game's QuarkHandler and Cube classes keep their amount private, behind add() and sub()
        if (typeof holder.add !== 'function' || typeof holder.sub !== 'function' || typeof holder.valueOf() !== 'number') return null;
        return typeof holder.applyBonus === 'function' && typeof holder.reset === 'function' ? 'quarks' : 'cube';
    }

    /** Writes the typed text into the leaf. Returns why it was refused, or null once written. */
    #write(leaf: HSDevLeaf, text: string): string | null {
        if (leaf.kind === 'string') {
            leaf.parent[leaf.key] = text;
            return null;
        }
        if (leaf.kind === 'boolean') {
            if (text !== 'true' && text !== 'false') return 'This field takes true or false';
            leaf.parent[leaf.key] = text === 'true';
            return null;
        }

        if (!NUMERIC_INPUT.test(text)) return `"${text}" is not a number (examples: 1500, 2.5e12)`;

        if (leaf.kind === 'decimal') {
            // The game's own Decimal class, not the mod's copy of break_infinity
            leaf.parent[leaf.key] = new (leaf.value as any).constructor(text);
            return null;
        }

        const amount = Number(text);
        if (!Number.isFinite(amount)) return `${text} is too large for this field`;

        if (leaf.kind === 'number') {
            leaf.parent[leaf.key] = amount;
            return null;
        }

        if (amount < 0) return 'This field cannot be negative';
        const holder = leaf.value as any;
        if (leaf.kind === 'quarks') {
            holder.reset();
            // No quark bonus, and not counted in the quarks of this singularity
            holder.add(amount, false, false);
        } else {
            holder.sub(holder.valueOf());
            holder.add(amount);
        }
        return null;
    }

    #format(leaf: HSDevLeaf): string {
        if (leaf.kind === 'boolean' || leaf.kind === 'string') return String(leaf.value);
        if (leaf.kind === 'decimal') {
            const { mantissa, exponent } = leaf.value as { mantissa: number, exponent: number };
            return exponent < 6 ? this.#formatNumber(mantissa * 10 ** exponent) : `${Math.round(mantissa * 100) / 100}e${exponent}`;
        }
        return this.#formatNumber(Number(leaf.value));
    }

    #formatNumber(value: number): string {
        if (!Number.isFinite(value)) return String(value);
        if (Math.abs(value) < 1e6) return String(Math.round(value * 1000) / 1000);
        const [mantissa, exponent] = value.toExponential(2).split('e');
        return `${Number(mantissa)}e${Number(exponent)}`;
    }

    /** 1 followed by the current exponent + 5 (6e7 gives 1e12). Empty for values that aren't amounts. */
    #suggest(leaf: HSDevLeaf): string {
        if (leaf.kind === 'boolean' || leaf.kind === 'string') return '';

        if (leaf.kind === 'decimal') {
            const { mantissa, exponent } = leaf.value as { mantissa: number, exponent: number };
            return `1e${(mantissa === 0 ? 0 : Math.max(0, exponent)) + SUGGESTION_EXPONENT_STEP}`;
        }

        const current = Number(leaf.value);
        // toExponential, not Math.log10: no rounding surprise on exact powers of ten
        const exponent = Number.isFinite(current) && current >= 1 ? Number(current.toExponential().split('e')[1]) : 0;
        return `1e${Math.min(exponent + SUGGESTION_EXPONENT_STEP, MAX_NUMBER_EXPONENT)}`;
    }

    // ===================
    // --- Rows and UI ---
    // ===================

    #el(tag: string, className: string, text?: string): HTMLElement {
        const element = document.createElement(tag);
        if (className) element.className = className;
        if (text !== undefined) element.textContent = text;
        return element;
    }

    #button(text: string, onClick: () => void): HTMLElement {
        const button = this.#el('div', 'hs-panel-btn hs-dev-tools-btn', text);
        button.addEventListener('click', onClick);
        return button;
    }

    #textInput(value: string, placeholder = ''): HTMLInputElement {
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'hs-dev-tools-input';
        input.spellcheck = false;
        input.value = value;
        input.placeholder = placeholder;
        return input;
    }

    #buildRow(def: HSDevRowDefinition): HTMLElement {
        const element = this.#el('div', 'hs-dev-tools-row');

        const label = this.#el('span', 'hs-dev-tools-label', def.label);
        label.title = def.path;
        const current = this.#el('span', 'hs-dev-tools-current');
        const input = this.#textInput('');

        // An empty field uses the suggestion shown in it. Once set, the field is emptied, so the next
        // suggestion shows (from the new value). Rows without a suggestion keep what was typed.
        const set = () => {
            const done = this.set(def.path, input.value.trim() || input.placeholder, def.label);
            if (done && def.suggest) input.value = '';
        };

        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') set(); });

        element.append(label, current, input, this.#button('Set', set));
        if (def.pinned) element.append(this.#button('x', () => this.#unpin(def.path)));

        this.#rows.push({ def, current, input });
        return element;
    }

    #buildFreeRow(): HTMLElement {
        const element = this.#el('div', 'hs-dev-tools-row');

        const path = this.#textInput(this.#data.freePath, 'cubeUpgrades.61');
        const current = this.#el('span', 'hs-dev-tools-current');
        const input = this.#textInput('', 'value');
        this.#freePath = path;
        this.#freeCurrent = current;

        const set = () => this.set(path.value, input.value);

        path.addEventListener('input', () => {
            this.#data.freePath = path.value;
            this.#saveData();
            this.#refreshFreeRow();
        });
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') set(); });

        element.append(path, current, input, this.#button('Set', set), this.#button('Pin', () => this.#pin(path.value)));
        return element;
    }

    #renderPinnedRows(): void {
        if (!this.#pinnedHolder) return;

        this.#rows = this.#rows.filter(row => !row.def.pinned);
        this.#pinnedHolder.replaceChildren();
        if (this.#data.pinned.length === 0) return;

        this.#pinnedHolder.append(this.#el('div', 'hs-dev-tools-group', 'Pinned fields'));
        for (const path of this.#data.pinned) {
            this.#pinnedHolder.append(this.#buildRow({ label: path, path, suggest: false, pinned: true }));
        }
        this.#refresh();
    }

    #pin(rawPath: string): void {
        const path = this.#normalizePath(rawPath);
        const leaf = this.#resolve(path);
        if (typeof leaf === 'string') { this.#fail(leaf); return; }
        if (this.#rows.some(row => row.def.path === path)) { this.#fail(`"${path}" already has a row`); return; }

        this.#data.pinned.push(path);
        this.#saveData();
        this.#renderPinnedRows();
    }

    #unpin(path: string): void {
        this.#data.pinned = this.#data.pinned.filter(pinned => pinned !== path);
        this.#saveData();
        this.#renderPinnedRows();
    }

    /** Current values and suggestions, read from the live player. Does nothing while the Debug tab is hidden. */
    #refresh(): void {
        if (!this.#root?.offsetParent) return;

        for (const row of this.#rows) {
            const leaf = this.#resolve(row.def.path);
            this.#showCurrent(row.current, leaf);

            const suggestion = typeof leaf !== 'string' && row.def.suggest ? this.#suggest(leaf) : '';
            if (row.input.placeholder !== suggestion) row.input.placeholder = suggestion;
        }
        this.#refreshFreeRow();
    }

    #refreshFreeRow(): void {
        if (!this.#freePath || !this.#freeCurrent) return;
        if (this.#freePath.value.trim() === '') {
            this.#freeCurrent.textContent = '';
            this.#freeCurrent.title = '';
            return;
        }
        this.#showCurrent(this.#freeCurrent, this.#resolve(this.#freePath.value));
    }

    #showCurrent(element: HTMLElement, leaf: HSDevLeaf | string): void {
        const text = typeof leaf === 'string' ? '-' : this.#format(leaf);
        const title = typeof leaf === 'string' ? leaf : leaf.kind;
        if (element.textContent !== text) element.textContent = text;
        if (element.title !== title) element.title = title;
    }

    // ====================================
    // --- Pinned rows, remembered path ---
    // ====================================

    #loadData(): void {
        // HSStorage.getData logs a warning for a key that was never written
        const exists = localStorage.getItem(`${HSGlobal.HSStorage.storagePrefix}${STORAGE_KEY}`) !== null;
        const stored = exists ? HSModuleManager.getModule<HSStorage>('HSStorage')?.getData<Partial<HSDevStoredData>>(STORAGE_KEY) : null;

        this.#data = {
            pinned: Array.isArray(stored?.pinned) ? stored.pinned : [],
            freePath: typeof stored?.freePath === 'string' ? stored.freePath : '',
        };
    }

    #saveData(): void {
        HSModuleManager.getModule<HSStorage>('HSStorage')?.setData(STORAGE_KEY, this.#data);
    }

    // =================
    // --- Snapshots ---
    // =================

    #buildSnapshotStatus(): HTMLElement {
        const element = this.#el('div', 'hs-dev-tools-status');
        this.#snapshotStatus = this.#el('span', '', 'No snapshot yet: one is taken before the first edit.');
        element.append(this.#snapshotStatus, this.#button('Download latest snapshot', () => { void this.#downloadLatestSnapshot(); }));
        return element;
    }

    /**
     * Takes the session's snapshot if there is none yet: the save as it is before the first edit.
     * Returns false when the edit should not go ahead (no snapshot, and the player said no).
     */
    #ensureSnapshot(): boolean {
        if (this.#sessionSnapshot || this.#snapshotWaived) return true;

        // Synchronous: clicks the game's save button and takes the save it serializes
        const save = HSModuleManager.getModule<HSGameData>('HSGameData')?.forceCaptureRawSaveSync();
        if (!save) {
            this.#snapshotWaived = window.confirm('Dev tools: the save could not be captured, so there is no snapshot to go back to.\n\nEdit anyway, for the rest of this session?');
            return this.#snapshotWaived;
        }

        const singularity = HSGlobal.exposedPlayer?.singularityCount ?? '?';
        this.#sessionSnapshot = { kind: 'auto', date: Date.now(), label: `Singularity ${singularity}`, save };
        if (this.#snapshotStatus) {
            this.#snapshotStatus.textContent = `Snapshot taken at ${new Date(this.#sessionSnapshot.date).toLocaleTimeString()} (${this.#sessionSnapshot.label}), before the first edit.`;
        }

        // The edit doesn't wait for the storage: the snapshot is also kept in memory for the download button
        void this.#storeSnapshot(this.#sessionSnapshot);
        return true;
    }

    #openSnapshotDb(): Promise<IDBDatabase> {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(SNAPSHOT_DB, 1);
            request.onupgradeneeded = () => {
                const store = request.result.createObjectStore(SNAPSHOT_STORE, { keyPath: 'id', autoIncrement: true });
                store.createIndex('kind', 'kind');
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    /** Stores a snapshot, then keeps only the last automatic ones. */
    async #storeSnapshot(snapshot: HSDevSnapshot): Promise<void> {
        try {
            const db = await this.#openSnapshotDb();
            try {
                await new Promise<void>((resolve, reject) => {
                    const transaction = db.transaction(SNAPSHOT_STORE, 'readwrite');
                    const store = transaction.objectStore(SNAPSHOT_STORE);
                    store.add(snapshot);

                    // Keys come oldest first
                    const autoKeys = store.index('kind').getAllKeys('auto');
                    autoKeys.onsuccess = () => {
                        for (const key of autoKeys.result.slice(0, -AUTO_SNAPSHOTS_KEPT)) store.delete(key);
                    };

                    transaction.oncomplete = () => resolve();
                    transaction.onerror = () => reject(transaction.error);
                    transaction.onabort = () => reject(transaction.error);
                });
            } finally {
                db.close();
            }
            HSLogger.log(`Snapshot stored (${snapshot.label})`, this.#context);
        } catch (error) {
            this.#fail(`Snapshot not stored (${error}): download it now to keep it`);
        }
    }

    async #latestStoredSnapshot(): Promise<HSDevSnapshot | undefined> {
        const db = await this.#openSnapshotDb();
        try {
            return await new Promise((resolve, reject) => {
                const request = db.transaction(SNAPSHOT_STORE).objectStore(SNAPSHOT_STORE).openCursor(null, 'prev');
                request.onsuccess = () => resolve(request.result?.value);
                request.onerror = () => reject(request.error);
            });
        } finally {
            db.close();
        }
    }

    /** Downloads the session's snapshot, or the last stored one, as a file the game's "Load from file" reads. */
    async #downloadLatestSnapshot(): Promise<void> {
        try {
            const snapshot = this.#sessionSnapshot ?? await this.#latestStoredSnapshot();
            if (!snapshot) {
                this.#fail('No snapshot yet');
                return;
            }

            // Same content as the game's export: the save JSON in base64, one byte per character like btoa.
            // Not window.btoa itself: GDS hooks it, and would take this old save for the current one.
            const bytes = new Uint8Array(snapshot.save.length);
            for (let i = 0; i < bytes.length; i++) bytes[i] = snapshot.save.charCodeAt(i);
            const dataUrl = await new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result as string);
                reader.onerror = () => reject(reader.error);
                reader.readAsDataURL(new Blob([bytes]));
            });
            const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);

            const date = new Date(snapshot.date);
            const pad = (value: number) => String(value).padStart(2, '0');
            const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;

            const link = document.createElement('a');
            link.href = URL.createObjectURL(new Blob([base64], { type: 'text/plain' }));
            link.download = `hs-snapshot-${stamp}.txt`;
            document.body.appendChild(link);
            link.click();
            link.remove();
            window.setTimeout(() => URL.revokeObjectURL(link.href), 10000);

            HSLogger.log(`Snapshot downloaded (${snapshot.label}, ${date.toLocaleString()})`, this.#context);
        } catch (error) {
            this.#fail(`Snapshot download failed: ${error}`);
        }
    }
}
