import { AMBROSIA_LOADOUT_SLOT, BlueberryLoadoutMode } from "../../types/module-types/hs-ambrosia-types";
import { HSLogger } from "../hs-core/hs-logger";
import { HSUtils } from "../hs-utils/hs-utils";
import { HSElementHooker } from "../hs-core/hs-elementhooker";
import { HSGlobal } from "../hs-core/hs-global";
import { HSModuleManager } from "../hs-core/module/hs-module-manager";
import type { HSGameData } from "../hs-core/gds/hs-gamedata";

/**
 * Class: HSAmbrosiaHelper
 * IsExplicitHSModule: No
 * Description:
 *     Static helper class for the HSAmbrosia module. Contains utility methods
 *     for resolving and formatting ambrosia loadout and icon states.
 */
export class HSAmbrosiaHelper {
    static #context: string = 'HSAmbrosiaHelper';

    static #cachedBlueberryToggleModeButton: HTMLButtonElement | undefined;
    static #cachedQuickbarSummaryElements: HTMLElement[] | undefined;
    static readonly #englishModeLabels: Record<BlueberryLoadoutMode, string> = {
        loadTree: 'MODE: LOAD LOADOUT',
        saveTree: 'MODE: SAVE LOADOUT'
    };

    static async cacheBlueberryToggleModeButton(): Promise<HTMLButtonElement | undefined> {
        if (this.#cachedBlueberryToggleModeButton instanceof HTMLButtonElement) {
            return this.#cachedBlueberryToggleModeButton;
        }
        const element = await HSElementHooker.HookElement('#blueberryToggleMode');
        if (element instanceof HTMLButtonElement) {
            this.#cachedBlueberryToggleModeButton = element;
            return element;
        }
        HSLogger.warn('Could not cache blueberry loadout mode toggle button', this.#context);
        return undefined;
    }

    static getCachedQuickbarSummaryElements(): HTMLElement[] {
        if (this.#cachedQuickbarSummaryElements) {
            return this.#cachedQuickbarSummaryElements;
        }
        const elements = Array.from(document.querySelectorAll<HTMLElement>('.hs-quickbar-summary-wrapper'));
        this.#cachedQuickbarSummaryElements = elements;
        return elements;
    }

    /** Resolve an ambrosia loadout slot enum by its slot ID string. */
    static getSlotEnumBySlotId(slotId: string): AMBROSIA_LOADOUT_SLOT | undefined {
        return Object.values(AMBROSIA_LOADOUT_SLOT).find((slot) => slot === slotId) as AMBROSIA_LOADOUT_SLOT | undefined;
    }

    /** Extract numeric slot index from slot enum string (e.g., blueberryLoadout1 -> 1). */
    static getLoadoutNumberFromSlot(slot: AMBROSIA_LOADOUT_SLOT): number | undefined {
        // The slot values are expected to have numeric endings in the format "blueberryLoadoutN".
        // This method extracts that tail number and confirms it's a valid positive integer.
        const match = slot.match(/(\d+)$/);
        if (!match) return undefined;

        const value = Number(match[1]);
        return Number.isInteger(value) && value > 0 ? value : undefined;
    }

    /** Normalize a saved/loadout string to a real AMBROSIA_LOADOUT_SLOT enum value. */
    static resolveAmbrosiaLoadout(value?: string | AMBROSIA_LOADOUT_SLOT | null): AMBROSIA_LOADOUT_SLOT | undefined {
        if (value === null || value === undefined) return undefined;

        // Accept canonical and numeric formats, e.g. blueberryLoadout1, Loadout 1, 1.
        const input = String(value);
        const normalized = HSUtils.removeColorTags(input).trim();

        // direct enum style
        const direct = this.getSlotEnumBySlotId(normalized);
        if (direct) return direct;

        // plain number style
        const indexMatch = normalized.match(/^(?:Loadout\s*)?(\d+)$/i);
        if (indexMatch) {
            return this.convertSettingLoadoutToSlot(indexMatch[1]);
        }

        return undefined;
    }

    /** Convert loadout-setting string (e.g. "1") to a real slot enum. */
    static convertSettingLoadoutToSlot(loadoutNumber: string): AMBROSIA_LOADOUT_SLOT | undefined {
        const loadoutEnum = Object.values(AMBROSIA_LOADOUT_SLOT).find(
            slot => slot === `blueberryLoadout${loadoutNumber}`
        ) as AMBROSIA_LOADOUT_SLOT | undefined;
        if (!loadoutEnum) {
            HSLogger.warn(`Check your loadout settings (missing loadout).`, this.#context);
            return undefined;
        }

        return loadoutEnum;
    }

    /**
     * Read the game's loadout mode, independent of the game language.
     * 1. Live player object (patched loaders), 2. a fresh save captured synchronously by GDS.
     * Returns undefined when neither is available.
     */
    static #readLoadoutMode(): BlueberryLoadoutMode | undefined {
        const playerMode = HSGlobal.exposedPlayer?.blueberryLoadoutMode;
        if (playerMode === 'loadTree' || playerMode === 'saveTree') return playerMode;

        const rawSave = HSModuleManager.getModule<HSGameData>('HSGameData')?.forceCaptureRawSaveSync();
        const savedMode = rawSave?.match(/"blueberryLoadoutMode"\s*:\s*"(loadTree|saveTree)"/)?.[1];
        return savedMode as BlueberryLoadoutMode | undefined;
    }

    /** Whether the game is currently in the specified loadout mode. May trigger a game save (GDS). */
    static isLoadoutMode(mode: BlueberryLoadoutMode): boolean {
        const currentMode = this.#readLoadoutMode();
        if (currentMode) return currentMode === mode;

        // Last resort: English button text
        const modeButton = this.#cachedBlueberryToggleModeButton;
        if (!modeButton) { HSLogger.warn(`modeButton not found.`, this.#context); return false; }

        return modeButton.innerText?.trim().toUpperCase() === HSAmbrosiaHelper.#englishModeLabels[mode];
    }

    /** Ensure the game is in the specified loadout mode before clicking slots. */
    static ensureLoadoutMode(mode: BlueberryLoadoutMode): void {
        const modeButton = this.#cachedBlueberryToggleModeButton;
        if (!modeButton) { HSLogger.warn(`modeButton not found.`, this.#context); return; }

        if (!this.isLoadoutMode(mode)) {
            modeButton.click();
        }
    }

    /** Show or hide other quickbars' summary headers. */
    static setQuickbarTopTextVisibility(visibility: boolean): void {
        const quickbarSummaryElements = this.getCachedQuickbarSummaryElements();

        quickbarSummaryElements.forEach(
            (el) => el.classList.toggle('hs-hidden', !visibility)
        );
    }
}
