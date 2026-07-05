import './target-selection.scss';
import { LoadTemplate } from 'src/app/user-interface/template';
import { Global } from 'src/app/global';
import { ImageLoader } from 'src/app/utils/image-loader';
import { Lookup } from 'src/shared/utils/lookup';
import { BarType } from 'src/app/stores/plotter.store';
import type { Plotter } from 'src/app/user-interface/pages/simulate/plotter/plotter';

declare global {
    interface HTMLElementTagNameMap {
        'mcs-target-selection': TargetSelection;
    }
}

interface SectionDefinition {
    key: string;
    title: string;
    barType: BarType;
    /** Optional predicate to further split a bar type into multiple sections (e.g. monster variants). */
    predicate?: (monsterId: string) => boolean;
    /** Whether this section is available for the current entitlements. */
    available: () => boolean;
}

interface TargetRow {
    index: number;
    name: string;
    media: string;
    row: HTMLLabelElement;
    checkbox: HTMLInputElement;
}

interface Section {
    definition: SectionDefinition;
    container: HTMLDivElement;
    body: HTMLDivElement;
    count: HTMLSpanElement;
    rows: TargetRow[];
}

@LoadTemplate('app/user-interface/pages/simulate/target-selection/target-selection.html')
export class TargetSelection extends HTMLElement {
    private readonly _content = new DocumentFragment();

    private readonly _root: HTMLDivElement;
    private readonly _toggle: HTMLButtonElement;
    private readonly _summary: HTMLSpanElement;
    private readonly _body: HTMLDivElement;
    private readonly _searchInput: HTMLInputElement;
    private readonly _sectionsContainer: HTMLDivElement;
    private readonly _empty: HTMLDivElement;

    private _plotter: Plotter;
    private _sections: Section[] = [];
    private _search = '';

    constructor() {
        super();

        this._content.append(getTemplateNode('mcs-target-selection-template'));

        this._root = getElementFromFragment(this._content, 'mcs-target-selection-root', 'div');
        this._toggle = getElementFromFragment(this._content, 'mcs-target-selection-toggle', 'button');
        this._summary = getElementFromFragment(this._content, 'mcs-target-selection-summary', 'span');
        this._body = getElementFromFragment(this._content, 'mcs-target-selection-body', 'div');
        this._searchInput = getElementFromFragment(this._content, 'mcs-target-selection-search-input', 'input');
        this._sectionsContainer = getElementFromFragment(this._content, 'mcs-target-selection-sections', 'div');
        this._empty = getElementFromFragment(this._content, 'mcs-target-selection-empty', 'div');
    }

    public connectedCallback() {
        this.appendChild(this._content);

        this._plotter = Global.userInterface.main.querySelector('mcs-plotter');

        this._toggle.onclick = () => this._root.classList.toggle('mcs-collapsed');

        this._searchInput.oninput = () => {
            this._search = this._searchInput.value.trim().toLowerCase();
            this._applyFilter();
        };

        this._build();
        this._refresh();
    }

    private get _sectionDefinitions(): SectionDefinition[] {
        const isAbyssal = (monsterId: string) =>
            cloudManager.hasItAEntitlementAndIsEnabled &&
            Lookup.monsters.getObjectByID(monsterId)?.damageType?.id === Lookup.abyssalDamage.id;

        const hasBarrier = (monsterId: string) => Lookup.monsters.getObjectByID(monsterId)?.hasBarrier === true;

        return [
            {
                key: 'monsters',
                title: 'Monsters',
                barType: BarType.Monster,
                predicate: (monsterId: string) => !hasBarrier(monsterId) && !isAbyssal(monsterId),
                available: () => true
            },
            {
                key: 'barrier-monsters',
                title: 'Barrier Monsters',
                barType: BarType.Monster,
                predicate: (monsterId: string) => hasBarrier(monsterId),
                available: () => cloudManager.hasAoDEntitlementAndIsEnabled
            },
            {
                key: 'abyssal-monsters',
                title: 'Abyssal Monsters',
                barType: BarType.Monster,
                predicate: (monsterId: string) => !hasBarrier(monsterId) && isAbyssal(monsterId),
                available: () => cloudManager.hasItAEntitlementAndIsEnabled
            },
            {
                key: 'dungeons',
                title: 'Dungeons',
                barType: BarType.Dungeon,
                available: () => true
            },
            {
                key: 'strongholds',
                title: 'Strongholds',
                barType: BarType.Stronghold,
                available: () => true
            },
            {
                key: 'depths',
                title: 'The Abyss',
                barType: BarType.Depth,
                available: () => cloudManager.hasItAEntitlementAndIsEnabled
            },
            {
                key: 'slayer',
                title: 'Slayer Tasks',
                barType: BarType.Task,
                available: () => true
            }
        ];
    }

    private _build() {
        this._sections = [];
        this._sectionsContainer.replaceChildren();

        const types = Global.stores.plotter.state.bars.types;
        const monsterIds = Global.stores.plotter.state.bars.monsterIds;

        for (const definition of this._sectionDefinitions) {
            if (!definition.available()) {
                continue;
            }

            const indices: number[] = [];

            for (let index = 0; index < types.length; index++) {
                if (types[index] !== definition.barType) {
                    continue;
                }

                if (definition.predicate && !definition.predicate(monsterIds[index])) {
                    continue;
                }

                indices.push(index);
            }

            if (!indices.length) {
                continue;
            }

            this._sections.push(this._buildSection(definition, indices));
        }
    }

    private _buildSection(definition: SectionDefinition, indices: number[]): Section {
        const container = createElement('div', { className: 'mcs-target-selection-section' });

        const header = createElement('div', { className: 'mcs-target-selection-section-header' });

        const sectionToggle = createElement('button', { className: 'mcs-target-selection-section-toggle' });
        sectionToggle.type = 'button';

        const chevron = createElement('span', {
            className: 'mcs-target-selection-section-chevron',
            text: '▼'
        });
        const title = createElement('span', { text: definition.title });
        const count = createElement('span', { className: 'mcs-target-selection-section-count' });

        sectionToggle.append(chevron, title, count);
        sectionToggle.onclick = () => container.classList.toggle('mcs-collapsed');

        const actions = createElement('div', { className: 'mcs-target-selection-section-actions' });

        const allButton = createElement('button', { className: 'mcs-target-selection-quick', text: 'All' });
        allButton.type = 'button';
        allButton.onclick = () => this._setSection(section, true);

        const noneButton = createElement('button', { className: 'mcs-target-selection-quick', text: 'None' });
        noneButton.type = 'button';
        noneButton.onclick = () => this._setSection(section, false);

        actions.append(allButton, noneButton);
        header.append(sectionToggle, actions);

        const body = createElement('div', { className: 'mcs-target-selection-section-body' });

        const rows: TargetRow[] = [];

        for (const index of indices) {
            rows.push(this._buildRow(index, body));
        }

        container.append(header, body);
        this._sectionsContainer.append(container);

        const section: Section = { definition, container, body, count, rows };

        return section;
    }

    private _buildRow(index: number, body: HTMLDivElement): TargetRow {
        const row = createElement('label', { className: 'mcs-target-selection-row' });

        const checkbox = createElement('input');
        checkbox.type = 'checkbox';

        const image = createElement('img', { className: 'mcs-target-selection-row-image' });
        ImageLoader.register(image, this._mediaForIndex(index));

        const name = this._plotter.getDetails(index).name;
        const nameElement = createElement('span', { className: 'mcs-target-selection-row-name', text: name });

        checkbox.onchange = () => {
            // _toggleEntity flips the underlying filter and calls back into _refresh via the plotter.
            if (this._isChecked(index) !== checkbox.checked) {
                this._plotter._toggleEntity(index);
            }
        };

        row.append(checkbox, image, nameElement);
        body.append(row);

        return { index, name, media: this._mediaForIndex(index), row, checkbox };
    }

    private _mediaForIndex(index: number): string {
        const id = Global.stores.plotter.state.bars.monsterIds[index];

        if (Global.stores.plotter.barIsTask(index)) {
            return Global.game.slayer.media;
        }

        if (Global.stores.plotter.barIsDungeon(index)) {
            return Lookup.dungeons.getObjectByID(id)?.media ?? '';
        }

        if (Global.stores.plotter.barIsStronghold(index)) {
            return Lookup.strongholds.getObjectByID(id)?.media ?? '';
        }

        if (Global.stores.plotter.barIsDepth(index)) {
            return Lookup.depths.getObjectByID(id)?.media ?? '';
        }

        return Lookup.monsters.getObjectByID(id)?.media ?? '';
    }

    private _isChecked(index: number): boolean {
        const id = Global.stores.plotter.state.bars.monsterIds[index];

        if (Global.stores.plotter.barIsDungeon(index)) {
            return !!Global.simulation.dungeonSimFilter[id];
        }

        if (Global.stores.plotter.barIsStronghold(index)) {
            return !!Global.simulation.strongholdSimFilter[id];
        }

        if (Global.stores.plotter.barIsDepth(index)) {
            return !!Global.simulation.depthSimFilter[id];
        }

        if (Global.stores.plotter.barIsTask(index)) {
            return !!Global.simulation.slayerSimFilter[id];
        }

        return !!Global.simulation.monsterSimFilter[id];
    }

    private _setSection(section: Section, enabled: boolean) {
        for (const { index } of section.rows) {
            if (this._isChecked(index) !== enabled) {
                this._plotter._toggleEntity(index);
            }
        }

        // _toggleEntity triggers _refresh, but call once more to be safe if the section was empty.
        this._refresh();
    }

    /** Re-read the current filter state and update every checkbox + summary. Safe to call repeatedly. */
    public _refresh() {
        let checkedTotal = 0;
        let total = 0;

        for (const section of this._sections) {
            let sectionChecked = 0;

            for (const { index, checkbox } of section.rows) {
                const checked = this._isChecked(index);
                checkbox.checked = checked;

                if (checked) {
                    sectionChecked++;
                }
            }

            section.count.textContent = `${sectionChecked}/${section.rows.length}`;
            checkedTotal += sectionChecked;
            total += section.rows.length;
        }

        this._summary.textContent = total ? `${checkedTotal} of ${total} selected` : '';

        this._applyFilter();
    }

    private _applyFilter() {
        let anyVisible = false;

        for (const section of this._sections) {
            let sectionVisible = false;

            for (const { name, row } of section.rows) {
                const visible = !this._search || name.toLowerCase().includes(this._search);
                row.style.display = visible ? '' : 'none';

                if (visible) {
                    sectionVisible = true;
                }
            }

            section.container.style.display = sectionVisible ? '' : 'none';

            if (sectionVisible) {
                anyVisible = true;
            }
        }

        this._empty.style.display = anyVisible ? 'none' : '';
    }
}

customElements.define('mcs-target-selection', TargetSelection);
