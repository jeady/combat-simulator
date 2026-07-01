/**
 * Read-only renderers that turn an optimizer setup into icons — the visual half of the
 * auto-optimize live feedback (the "now evaluating" grid, the new-best feed, the leaderboard).
 *
 * This is UI-layer code, so touching `Global.*` and the game is fine here (unlike the pure
 * optimizer core). It reuses the same item assets and tooltips as the real equipment page:
 * `item.media`, lazy {@link ImageLoader}, and {@link EquipmentController.getEquipmentTooltip}.
 */
import { Global } from 'src/app/global';
import { ImageLoader } from 'src/app/utils/image-loader';
import { TooltipController } from 'src/app/user-interface/_parts/tooltip/tooltip-controller';
import { EquipmentController } from 'src/app/user-interface/pages/_parts/equipment/equipment-controller';
import { Dimension, DimensionChoice } from 'src/app/optimizer/types';

/** A setup split into its renderable parts: equipped gear by slot, and consumable dimensions. */
export interface RenderedLoadout {
    /** slotId -> itemId, non-empty slots only. */
    equipment: Map<string, string>;
    /**
     * One entry per non-equipment dimension (food, potion, prayers, …), in dimension order.
     * `itemIds` are the icons to render — 0 for none, 1 for food/potion, up to 2 for a prayer set.
     */
    consumables: { id: string; label: string; itemIds: string[] }[];
}

/**
 * Split an aligned (dimensions, choices) pair into equipment vs consumable dimensions. Equipment
 * dimensions are detected by their id being a real equipment slot (see `equipmentDimensions`);
 * everything else (food, potion, …) is treated as a consumable whose choice is an item id.
 */
export function choicesToLoadout(dims: Dimension[], choices: DimensionChoice[]): RenderedLoadout {
    const equipment = new Map<string, string>();
    const consumables: RenderedLoadout['consumables'] = [];

    dims.forEach((dim, index) => {
        const choice = choices[index];
        if (Global.game.equipmentSlots.getObjectByID(dim.id)) {
            if (choice != null && choice !== '') {
                equipment.set(dim.id, choice as string);
            }
        } else {
            // Consumable choices are usually a single id (food/potion), but the prayers dimension's
            // choice is a set of prayer ids — normalise both to a flat id list for rendering.
            const itemIds = Array.isArray(choice)
                ? (choice as string[]).filter(Boolean)
                : choice
                ? [choice as string]
                : [];
            consumables.push({ id: dim.id, label: dim.label, itemIds });
        }
    });

    return { equipment, consumables };
}

/** A single icon cell with an optional hover tooltip, matching the equipment page's look. */
function iconCell(media: string, tooltipHtml: string | undefined, classes: string[]): HTMLDivElement {
    const cell = createElement('div', { classList: ['mcs-ao-icon', ...classes] });

    const img = createElement('img', { classList: ['mcs-ao-icon-img'] });
    ImageLoader.register(img, media);
    cell.appendChild(img);

    if (tooltipHtml) {
        cell.setAttribute('data-mcsTooltip', '');
        const content = createElement('div', { attributes: [['data-mcsTooltipContent', '']] });
        content.innerHTML = tooltipHtml;
        cell.appendChild(content);
        TooltipController.init(cell);
    }

    return cell;
}

/** Tooltip + media for an equipment item id, falling back to a slot's empty art. */
function equipmentIcon(slotId: string, itemId: string | undefined, classes: string[]): HTMLDivElement {
    const slot = Global.game.equipmentSlots.getObjectByID(slotId);
    const item = itemId ? Global.game.items.equipment.getObjectByID(itemId) : undefined;

    if (item) {
        return iconCell(item.media, EquipmentController.getEquipmentTooltip(item), classes);
    }
    // Empty slot: show its silhouette so the grid stays a recognisable paper-doll.
    return iconCell(slot?.emptyMedia ?? '', slot?.localID, ['mcs-ao-icon-empty', ...classes]);
}

/** Resolve an id to its media + display name, trying the item, prayer, then spell registries. */
function resolveEntity(id: string): { media: string; name: string } | undefined {
    const item = Global.game.items.getObjectByID(id);
    if (item) {
        return { media: item.media, name: item.name };
    }
    const prayer = Global.game.prayers.getObjectByID(id);
    if (prayer) {
        return { media: prayer.media, name: prayer.name };
    }
    // Spell dimensions (attack spell / curse / aurora) — ids live in the spell registries, not items.
    const spell =
        Global.game.attackSpells.getObjectByID(id) ??
        Global.game.curseSpells.getObjectByID(id) ??
        Global.game.auroraSpells.getObjectByID(id);
    if (spell) {
        return { media: spell.media, name: spell.name };
    }
    return undefined;
}

/** A consumable dimension as its 1+ icons (food/potion = 1, a prayer set = up to 2), or a "none" cell. */
function consumableGroup(consumable: RenderedLoadout['consumables'][number], classes: string[]): HTMLElement {
    const group = createElement('div', { classList: ['mcs-ao-consumable-group', ...classes] });

    const resolved = consumable.itemIds.map(resolveEntity).filter((entity): entity is { media: string; name: string } => !!entity);

    if (resolved.length === 0) {
        const tooltip = `<div class="text-warning">${consumable.label}</div><div>None</div>`;
        group.appendChild(iconCell(Global.game.emptyFoodItem?.media ?? '', tooltip, ['mcs-ao-icon-empty']));
        return group;
    }

    for (const entity of resolved) {
        const tooltip = `<div class="text-warning">${consumable.label}</div><div>${entity.name}</div>`;
        group.appendChild(iconCell(entity.media, tooltip, []));
    }
    return group;
}

/**
 * A live, in-place equipment grid (paper-doll) plus a consumables strip. Built once; `update()`
 * swaps icon sources and the highlight without rebuilding the DOM, so it stays cheap to refresh
 * for every evaluated candidate during a run.
 */
export class LiveLoadoutGrid {
    public readonly element: HTMLElement;

    private readonly grid: HTMLDivElement;
    private readonly consumablesRow: HTMLDivElement;
    private readonly cells = new Map<string, { cell: HTMLDivElement; img: HTMLImageElement; tooltip: HTMLDivElement }>();

    constructor() {
        this.element = createElement('div', { classList: ['mcs-ao-live'] });

        this.grid = createElement('div', { classList: ['mcs-ao-grid'] });
        const size = (EquipmentSlot as any).getGridSize();
        const numCols = size.cols.max - size.cols.min + 1;
        const numRows = size.rows.max - size.rows.min + 1;
        const colOffset = 1 - size.cols.min;
        const rowOffset = 1 - size.rows.min;
        this.grid.style.gridTemplateColumns = `repeat(${numCols}, auto)`;
        this.grid.style.gridTemplateRows = `repeat(${numRows}, auto)`;

        Global.game.equipmentSlots.forEach(slot => {
            const cell = createElement('div', { classList: ['mcs-ao-icon', 'mcs-ao-icon-empty'] });
            cell.style.gridColumn = `${slot.gridPosition.col + colOffset}`;
            cell.style.gridRow = `${slot.gridPosition.row + rowOffset}`;
            cell.setAttribute('data-mcsTooltip', '');

            const img = createElement('img', { classList: ['mcs-ao-icon-img'] });
            ImageLoader.register(img, slot.emptyMedia);
            cell.appendChild(img);

            const tooltip = createElement('div', { attributes: [['data-mcsTooltipContent', '']] });
            tooltip.innerHTML = slot.localID;
            cell.appendChild(tooltip);
            TooltipController.init(cell);

            this.cells.set(slot.id, { cell, img, tooltip });
            this.grid.appendChild(cell);
        });

        this.consumablesRow = createElement('div', { classList: ['mcs-ao-consumables'] });

        this.element.append(this.grid, this.consumablesRow);
    }

    /** Repaint to show `loadout`, optionally flagging one slot as the one being tested. */
    public update(loadout: RenderedLoadout, highlightSlotId?: string) {
        Global.game.equipmentSlots.forEach(slot => {
            const entry = this.cells.get(slot.id);
            if (!entry) {
                return;
            }
            const itemId = loadout.equipment.get(slot.id);
            const item = itemId ? Global.game.items.equipment.getObjectByID(itemId) : undefined;

            ImageLoader.register(entry.img, item ? item.media : slot.emptyMedia);
            entry.tooltip.innerHTML = item ? EquipmentController.getEquipmentTooltip(item) : slot.localID;
            entry.cell.classList.toggle('mcs-ao-icon-empty', !item);
            entry.cell.classList.toggle('mcs-ao-changed', slot.id === highlightSlotId);
        });

        this.consumablesRow.innerHTML = '';
        for (const consumable of loadout.consumables) {
            const classes = consumable.id === highlightSlotId ? ['mcs-ao-changed'] : [];
            this.consumablesRow.appendChild(consumableGroup(consumable, classes));
        }
    }
}

export interface LoadoutRowOptions {
    /** Emphasise a single dimension — the slot/consumable being tested this evaluation. */
    highlightDimId?: string;
    /**
     * Emphasise every slot/consumable whose choice differs from this reference loadout (e.g. the
     * user's currently-equipped setup). Takes precedence over {@link highlightDimId} when set.
     */
    diffFrom?: RenderedLoadout;
    /**
     * Render empty equipment slots as placeholders (instead of skipping them) so every row shows
     * the same slots in the same order — keeping each gear slot at a fixed position across rows.
     */
    showEmpty?: boolean;
}

/** Sorted, comma-joined key for a consumable's id list, for value-comparison against a baseline. */
function consumableKey(itemIds: string[]): string {
    return [...itemIds].sort().join(',');
}

/**
 * A compact one-line strip of the equipped gear (in slot order) followed by consumables — for the
 * new-best feed and the leaderboard, where many setups stack vertically and a full grid is too big.
 * With {@link LoadoutRowOptions.diffFrom} every item differing from that baseline is highlighted;
 * otherwise {@link LoadoutRowOptions.highlightDimId} emphasises the single slot/consumable that changed.
 */
export function loadoutRow(loadout: RenderedLoadout, opts: LoadoutRowOptions = {}): HTMLElement {
    const row = createElement('div', { classList: ['mcs-ao-row'] });

    Global.game.equipmentSlots.forEach(slot => {
        const itemId = loadout.equipment.get(slot.id);
        if (!itemId && !opts.showEmpty) {
            return; // compact: skip empty slots entirely
        }
        const highlight = opts.diffFrom
            ? opts.diffFrom.equipment.get(slot.id) !== itemId
            : opts.highlightDimId === slot.id;
        // equipmentIcon renders the slot's empty silhouette when itemId is undefined.
        row.appendChild(equipmentIcon(slot.id, itemId, highlight ? ['mcs-ao-changed'] : []));
    });

    for (const consumable of loadout.consumables) {
        if (consumable.itemIds.length === 0) {
            continue; // compact: skip empty consumable dimensions
        }
        const baseline = opts.diffFrom?.consumables.find(entry => entry.id === consumable.id);
        const highlight = opts.diffFrom
            ? consumableKey(baseline?.itemIds ?? []) !== consumableKey(consumable.itemIds)
            : opts.highlightDimId === consumable.id;
        row.appendChild(consumableGroup(consumable, highlight ? ['mcs-ao-changed'] : []));
    }

    return row;
}
