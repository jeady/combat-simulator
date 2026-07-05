import './target-selection.scss';
import { LoadTemplate } from 'src/app/user-interface/template';
import { Global } from 'src/app/global';
import { ImageLoader } from 'src/app/utils/image-loader';
import { Lookup } from 'src/shared/utils/lookup';
import { Format } from 'src/app/utils/format';
import { ButtonImage } from 'src/app/user-interface/_parts/button-image/button-image';
import type { Plotter } from 'src/app/user-interface/pages/simulate/plotter/plotter';

declare global {
    interface HTMLElementTagNameMap {
        'mcs-target-selection': TargetSelection;
    }
}

/** A single selectable target row: writes directly to its filter object keyed by id. */
interface TargetRow {
    id: string;
    name: string;
    row: HTMLLabelElement;
    checkbox: HTMLInputElement;
    /** Read the current enabled state from the sim filter store. */
    isEnabled: () => boolean;
    /** Write the enabled state to the sim filter store. */
    setEnabled: (enabled: boolean) => void;
}

/** An area grouping within a monster category (combat area / slayer area / the bard). */
interface AreaGroup {
    container: HTMLDivElement;
    header: HTMLDivElement;
    toggle: HTMLInputElement;
    rows: TargetRow[];
}

/** One of the seven top-level categories. */
interface Category {
    key: string;
    title: string;
    media: string;
    /** Whether this category is available for the current entitlements. */
    available: () => boolean;
    /** Whether the plotter currently has this whole category toggled on. */
    isToggled: () => boolean;
    /** Flip the whole category on/off via the plotter (mirrors the old quick-toggle icons). */
    toggleAll: () => void;
    /** Build the expandable body's rows; grouped monster categories return area groups. */
    build: (body: HTMLDivElement) => { groups: AreaGroup[]; rows: TargetRow[] };
    // Runtime element references, populated by _buildCategory.
    icon?: ButtonImage;
    arrow?: HTMLButtonElement;
    container?: HTMLDivElement;
    body?: HTMLDivElement;
    count?: HTMLSpanElement;
    groups?: AreaGroup[];
    rows?: TargetRow[];
    built?: boolean;
}

const isAbyssal = (monster: Monster) =>
    cloudManager.hasItAEntitlementAndIsEnabled && monster.damageType?.id === Lookup.abyssalDamage.id;

const isBarrier = (monster: Monster) => monster.hasBarrier === true;

const isNormal = (monster: Monster) => !isBarrier(monster) && !isAbyssal(monster);

@LoadTemplate('app/user-interface/pages/simulate/target-selection/target-selection.html')
export class TargetSelection extends HTMLElement {
    private readonly _content = new DocumentFragment();

    private readonly _root: HTMLDivElement;
    private readonly _searchInput: HTMLInputElement;
    private readonly _categoriesContainer: HTMLDivElement;

    private _plotter: Plotter;
    private _categories: Category[] = [];
    private _search = '';
    private _isInspecting = false;

    constructor() {
        super();

        this._content.append(getTemplateNode('mcs-target-selection-template'));

        this._root = getElementFromFragment(this._content, 'mcs-target-selection-root', 'div');
        this._searchInput = getElementFromFragment(this._content, 'mcs-target-selection-search-input', 'input');
        this._categoriesContainer = getElementFromFragment(this._content, 'mcs-target-selection-categories', 'div');
    }

    public connectedCallback() {
        this.appendChild(this._content);

        this._searchInput.oninput = () => {
            this._search = this._searchInput.value.trim().toLowerCase();
            this._applySearch();
        };

        // Build the category headers (icons + arrows) immediately from Lookup/game data. The heavy
        // per-target rows are built lazily on first expand, but even the headers here never read the
        // plotter's bar store (which is empty until the plotter constructs), so ordering is safe.
        this._buildCategories();
    }

    /** Lazily resolve the plotter; it is created after this component, so we look it up on demand. */
    private get plotter(): Plotter {
        if (!this._plotter) {
            this._plotter = Global.userInterface.main.querySelector('mcs-plotter');
        }

        return this._plotter;
    }

    private get _categoryDefinitions(): Category[] {
        return [
            {
                key: 'monsters',
                title: 'Normal Monsters',
                media: 'assets/media/skills/combat/combat.svg',
                available: () => true,
                isToggled: () => this.plotter?.monstersToggled ?? true,
                toggleAll: () => this.plotter?._toggleMonsters(),
                build: body => this._buildMonsterCategory(body, isNormal)
            },
            {
                key: 'barrier-monsters',
                title: 'Barrier Monsters',
                media: 'assets/media/skills/combat/barrier.svg',
                available: () => cloudManager.hasAoDEntitlementAndIsEnabled,
                isToggled: () => this.plotter?.barrierMonstersToggled ?? true,
                toggleAll: () => this.plotter?._toggleBarrierMonsters(),
                build: body => this._buildMonsterCategory(body, isBarrier)
            },
            {
                key: 'abyssal-monsters',
                title: 'Abyssal Monsters',
                media: 'assets/media/skills/combat/abyssal_damage.svg',
                available: () => cloudManager.hasItAEntitlementAndIsEnabled,
                isToggled: () => this.plotter?.abyssalMonstersToggled ?? true,
                toggleAll: () => this.plotter?._toggleAbyssalMonsters(),
                build: body => this._buildMonsterCategory(body, monster => !isBarrier(monster) && isAbyssal(monster))
            },
            {
                key: 'dungeons',
                title: 'Dungeons',
                media: 'assets/media/skills/combat/dungeon.svg',
                available: () => true,
                isToggled: () => this.plotter?.dungeonsToggled ?? false,
                toggleAll: () => this.plotter?._toggleDungeons(!this.plotter.dungeonsToggled),
                build: body => this._buildEntryCategory(body, this._dungeonRows())
            },
            {
                key: 'strongholds',
                title: 'Strongholds',
                media: 'assets/media/skills/combat/strongholds.svg',
                available: () => true,
                isToggled: () => this.plotter?.strongholdsToggled ?? false,
                toggleAll: () => this.plotter?._toggleStrongholds(!this.plotter.strongholdsToggled),
                build: body => this._buildEntryCategory(body, this._strongholdRows())
            },
            {
                key: 'depths',
                title: 'The Abyss',
                media: 'assets/media/skills/combat/the_abyss.svg',
                available: () => cloudManager.hasItAEntitlementAndIsEnabled,
                isToggled: () => this.plotter?.depthsToggled ?? false,
                toggleAll: () => this.plotter?._toggleDepths(!this.plotter.depthsToggled),
                build: body => this._buildEntryCategory(body, this._depthRows())
            },
            {
                key: 'slayer',
                title: 'Slayer Tasks',
                media: 'assets/media/skills/slayer/slayer.svg',
                available: () => true,
                isToggled: () => this.plotter?.slayerToggled ?? false,
                toggleAll: () => this.plotter?._toggleSlayer(!this.plotter.slayerToggled),
                build: body => this._buildEntryCategory(body, this._taskRows())
            }
        ];
    }

    private _buildCategories() {
        this._categories = [];
        this._categoriesContainer.replaceChildren();

        for (const definition of this._categoryDefinitions) {
            if (!definition.available()) {
                continue;
            }

            try {
                this._categories.push(this._buildCategory(definition));
            } catch (exception) {
                Global.logger.error(`Failed to build target category '${definition.key}'.`, exception);
            }
        }
    }

    private _buildCategory(definition: Category): Category {
        const container = createElement('div', { className: 'mcs-target-selection-category' });

        const header = createElement('div', { className: 'mcs-target-selection-category-header' });

        const icon = createElement('mcs-button-image', { className: 'mcs-target-selection-category-icon' });
        // Raw relative path, resolved against the game origin like the old toolbar buttons did —
        // these are GAME assets; Global.context.getResourceUrl only resolves mod-packaged resources
        // and throws for anything else, which silently killed the whole category build.
        icon.dataset.mcssrc = definition.media;
        icon.dataset.mcssmall = '';
        icon._on(() => {
            definition.toggleAll();
            // Category toggles run through the plotter, which refreshes this panel via
            // _applyVisibility -> parent._refreshTargetSelection. Sync the icon pressed-state now.
            this._syncToggles();
        });

        const arrow = createElement('button', { className: 'mcs-target-selection-category-arrow' });
        arrow.type = 'button';
        arrow.innerHTML = '&#9654;';

        const title = createElement('span', {
            className: 'mcs-target-selection-category-title',
            text: definition.title
        });

        const count = createElement('span', { className: 'mcs-target-selection-category-count' });

        arrow.onclick = () => {
            this._ensureBuilt(definition);
            container.classList.toggle('mcs-expanded');
        };

        header.append(icon, arrow, title, count);

        const body = createElement('div', { className: 'mcs-target-selection-category-body' });

        container.append(header, body);
        this._categoriesContainer.append(container);

        definition.icon = icon;
        definition.arrow = arrow;
        definition.container = container;
        definition.body = body;
        definition.count = count;
        definition.built = false;

        return definition;
    }

    /** Build the per-target rows for a category the first time it is expanded. */
    private _ensureBuilt(category: Category) {
        if (category.built) {
            return;
        }

        const { groups, rows } = category.build(category.body);

        category.groups = groups;
        category.rows = rows;
        category.built = true;

        this._refreshCategory(category);
        this._applySearch();
    }

    private _buildMonsterCategory(
        body: HTMLDivElement,
        predicate: (monster: Monster) => boolean
    ): { groups: AreaGroup[]; rows: TargetRow[] } {
        const groups: AreaGroup[] = [];
        const rows: TargetRow[] = [];

        const addArea = (name: string, monsters: Monster[]) => {
            const members = monsters.filter(predicate);

            if (!members.length) {
                return;
            }

            const group = this._buildAreaGroup(body, name);

            for (const monster of members) {
                const row = this._buildMonsterRow(group, monster);
                group.rows.push(row);
                rows.push(row);
            }

            groups.push(group);
        };

        for (const area of Lookup.combatAreas.combatAreas) {
            addArea(area.name, area.monsters);
        }

        const bard = Lookup.monsters.getObjectByID(Global.stores.game.state.bardId);

        if (bard) {
            const bardArea = Global.game.getMonsterArea(bard);
            addArea(bardArea?.name ?? 'Wandering Bard', [bard]);
        }

        for (const area of Lookup.combatAreas.slayer) {
            addArea(area.name, area.monsters);
        }

        return { groups, rows };
    }

    private _buildAreaGroup(body: HTMLDivElement, name: string): AreaGroup {
        const container = createElement('div', { className: 'mcs-target-selection-area' });

        const header = createElement('div', { className: 'mcs-target-selection-area-header' });

        const label = createElement('label', { className: 'mcs-target-selection-area-label' });

        const toggle = createElement('input');
        toggle.type = 'checkbox';

        const name_ = createElement('span', { className: 'mcs-target-selection-area-name', text: name });

        label.append(toggle, name_);
        header.append(label);
        container.append(header);
        body.append(container);

        const group: AreaGroup = { container, header, toggle, rows: [] };

        toggle.onchange = () => {
            for (const row of group.rows) {
                if (row.isEnabled() !== toggle.checked) {
                    row.setEnabled(toggle.checked);
                }
            }

            this._commit();
        };

        return group;
    }

    private _buildMonsterRow(group: AreaGroup, monster: Monster): TargetRow {
        return this._buildRow(group.container, {
            id: monster.id,
            name: Format.getMonsterName(monster.id),
            media: monster.media,
            isEnabled: () => !!Global.simulation.monsterSimFilter[monster.id],
            setEnabled: enabled => {
                Global.simulation.monsterSimFilter[monster.id] = enabled;
            }
        });
    }

    private _buildEntryCategory(
        body: HTMLDivElement,
        entries: {
            id: string;
            name: string;
            media: string;
            isEnabled: () => boolean;
            setEnabled: (enabled: boolean) => void;
        }[]
    ): { groups: AreaGroup[]; rows: TargetRow[] } {
        const rows: TargetRow[] = [];

        for (const entry of entries) {
            rows.push(this._buildRow(body, entry));
        }

        return { groups: [], rows };
    }

    private _dungeonRows() {
        return Lookup.combatAreas.dungeons.map(dungeon => ({
            id: dungeon.id,
            name: Format.replaceApostrophe(dungeon.name),
            media: dungeon.media,
            isEnabled: () => !!Global.simulation.dungeonSimFilter[dungeon.id],
            setEnabled: (enabled: boolean) => {
                Global.simulation.dungeonSimFilter[dungeon.id] = enabled;
            }
        }));
    }

    private _strongholdRows() {
        return Lookup.combatAreas.strongholds.map(stronghold => ({
            id: stronghold.id,
            name: Format.replaceApostrophe(stronghold.name),
            media: stronghold.media,
            isEnabled: () => !!Global.simulation.strongholdSimFilter[stronghold.id],
            setEnabled: (enabled: boolean) => {
                Global.simulation.strongholdSimFilter[stronghold.id] = enabled;
            }
        }));
    }

    private _depthRows() {
        return Lookup.combatAreas.depths.map(depth => ({
            id: depth.id,
            name: Format.replaceApostrophe(depth.name),
            media: depth.media,
            isEnabled: () => !!Global.simulation.depthSimFilter[depth.id],
            setEnabled: (enabled: boolean) => {
                Global.simulation.depthSimFilter[depth.id] = enabled;
            }
        }));
    }

    private _taskRows() {
        return Lookup.tasks.allObjects.map(task => ({
            id: task.id,
            name: `${task.name} Tasks`,
            media: Global.game.slayer.media,
            isEnabled: () => !!Global.simulation.slayerSimFilter[task.id],
            setEnabled: (enabled: boolean) => {
                Global.simulation.slayerSimFilter[task.id] = enabled;
            }
        }));
    }

    private _buildRow(
        parent: HTMLDivElement,
        entry: {
            id: string;
            name: string;
            media: string;
            isEnabled: () => boolean;
            setEnabled: (enabled: boolean) => void;
        }
    ): TargetRow {
        const row = createElement('label', { className: 'mcs-target-selection-row' });

        const checkbox = createElement('input');
        checkbox.type = 'checkbox';

        const image = createElement('img', { className: 'mcs-target-selection-row-image' });
        ImageLoader.register(image, entry.media);

        const name = createElement('span', { className: 'mcs-target-selection-row-name', text: entry.name });

        const target: TargetRow = {
            id: entry.id,
            name: entry.name,
            row,
            checkbox,
            isEnabled: entry.isEnabled,
            setEnabled: entry.setEnabled
        };

        checkbox.onchange = () => {
            if (target.isEnabled() !== checkbox.checked) {
                target.setEnabled(checkbox.checked);
                this._commit();
            }
        };

        row.append(checkbox, image, name);
        parent.append(row);

        return target;
    }

    /**
     * Apply a filter write: push the new state into the plotter (which re-lays out the chart to
     * show only enabled targets) and re-sync every checkbox + category icon in this panel.
     */
    private _commit() {
        this.plotter?._updateData();
        this._syncToggles();
        this._refresh();
    }

    /** Re-sync every category icon's pressed-state with the plotter's category-toggle flags. */
    public _syncToggles() {
        for (const category of this._categories) {
            category.icon?._toggle(category.isToggled());
        }
    }

    /** Re-read the current filter state and update every checkbox, area toggle and count. */
    public _refresh() {
        this._syncToggles();

        for (const category of this._categories) {
            this._refreshCategory(category);
        }
    }

    private _refreshCategory(category: Category) {
        if (!category.built) {
            return;
        }

        let enabled = 0;

        for (const row of category.rows) {
            const checked = row.isEnabled();
            row.checkbox.checked = checked;

            if (checked) {
                enabled++;
            }
        }

        for (const group of category.groups) {
            const total = group.rows.length;
            const checked = group.rows.filter(row => row.isEnabled()).length;

            group.toggle.checked = total > 0 && checked === total;
            group.toggle.indeterminate = checked > 0 && checked < total;
        }

        if (category.count) {
            category.count.textContent = `${enabled}/${category.rows.length}`;
        }
    }

    private _applySearch() {
        for (const category of this._categories) {
            if (!category.built) {
                continue;
            }

            let categoryVisible = false;

            for (const group of category.groups) {
                let groupVisible = false;

                for (const row of group.rows) {
                    const visible = !this._search || row.name.toLowerCase().includes(this._search);
                    row.row.style.display = visible ? '' : 'none';

                    if (visible) {
                        groupVisible = true;
                    }
                }

                group.container.style.display = groupVisible ? '' : 'none';

                if (groupVisible) {
                    categoryVisible = true;
                }
            }

            // Ungrouped rows (dungeons, strongholds, depths, tasks) live directly on the body.
            if (!category.groups.length) {
                for (const row of category.rows) {
                    const visible = !this._search || row.name.toLowerCase().includes(this._search);
                    row.row.style.display = visible ? '' : 'none';

                    if (visible) {
                        categoryVisible = true;
                    }
                }
            }

            // When searching, auto-expand categories that have matches and hide those that do not.
            if (this._search) {
                category.container.style.display = categoryVisible ? '' : 'none';
                category.container.classList.toggle('mcs-expanded', categoryVisible);
            } else {
                category.container.style.display = '';
            }
        }
    }

    /** Disable/enable panel interactions while inspecting a dungeon/task (filters do not apply then). */
    public _setInspecting(isInspecting: boolean) {
        this._isInspecting = isInspecting;
        this._root.classList.toggle('mcs-disabled', isInspecting);

        for (const category of this._categories) {
            if (category.icon) {
                category.icon.toggleAttribute('data-mcsdisabled', isInspecting);
            }
        }
    }
}

customElements.define('mcs-target-selection', TargetSelection);
