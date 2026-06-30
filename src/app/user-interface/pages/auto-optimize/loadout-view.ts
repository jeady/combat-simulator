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
    /** One entry per non-equipment dimension (food, potion, …), in dimension order. */
    consumables: { id: string; label: string; itemId: string | null }[];
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
            consumables.push({ id: dim.id, label: dim.label, itemId: (choice as string) ?? null });
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

/** Tooltip + media for a consumable choice (food/potion item id), or a "none" placeholder. */
function consumableIcon(consumable: RenderedLoadout['consumables'][number], classes: string[]): HTMLDivElement {
    const item = consumable.itemId ? Global.game.items.getObjectByID(consumable.itemId) : undefined;
    if (item) {
        const tooltip = `<div class="text-warning">${consumable.label}</div><div>${item.name}</div>`;
        return iconCell(item.media, tooltip, classes);
    }
    const tooltip = `<div class="text-warning">${consumable.label}</div><div>None</div>`;
    return iconCell(Global.game.emptyFoodItem?.media ?? '', tooltip, ['mcs-ao-icon-empty', ...classes]);
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
            this.consumablesRow.appendChild(consumableIcon(consumable, classes));
        }
    }
}

/**
 * A compact one-line strip of the equipped gear (in slot order) followed by consumables — for the
 * new-best feed and the leaderboard, where many setups stack vertically and a full grid is too big.
 * `highlightDimId` emphasises the slot/consumable that changed.
 */
export function loadoutRow(loadout: RenderedLoadout, highlightDimId?: string): HTMLElement {
    const row = createElement('div', { classList: ['mcs-ao-row'] });

    Global.game.equipmentSlots.forEach(slot => {
        const itemId = loadout.equipment.get(slot.id);
        if (!itemId) {
            return; // compact: skip empty slots entirely
        }
        const classes = slot.id === highlightDimId ? ['mcs-ao-changed'] : [];
        row.appendChild(equipmentIcon(slot.id, itemId, classes));
    });

    for (const consumable of loadout.consumables) {
        if (!consumable.itemId) {
            continue;
        }
        const classes = consumable.id === highlightDimId ? ['mcs-ao-changed'] : [];
        row.appendChild(consumableIcon(consumable, classes));
    }

    return row;
}
