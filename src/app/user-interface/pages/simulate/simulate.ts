import './simulate.scss';
import { LoadTemplate } from 'src/app/user-interface/template';
import { Dropdown, DropdownOption } from 'src/app/user-interface/_parts/dropdown/dropdown';
import { Plotter } from './plotter/plotter';
import { Global } from 'src/app/global';
import { PlotKey } from 'src/app/stores/plotter.store';
import { Information } from 'src/app/user-interface/information/information';
import { Drops } from 'src/app/drops';
import { Switch } from 'src/app/user-interface/_parts/switch/switch';
import { StorageKey } from 'src/app/utils/account-storage';
import { TargetSelection } from 'src/app/user-interface/pages/simulate/target-selection/target-selection';

declare global {
    interface HTMLElementTagNameMap {
        'mcs-simulate': SimulatePage;
    }
}

@LoadTemplate('app/user-interface/pages/simulate/simulate.html')
export class SimulatePage extends HTMLElement {
    private readonly _content = new DocumentFragment();

    private readonly _plotter: Plotter;
    private readonly _targetSelection: TargetSelection;

    private readonly _skill: Dropdown;
    private readonly _plotType: Dropdown;
    private readonly _time: Dropdown;
    public readonly _selectTarget: Dropdown;
    private readonly _activeTarget: HTMLButtonElement;

    private readonly _slayer: Switch;
    private readonly _inspect: HTMLButtonElement;
    private readonly _stopInspect: HTMLButtonElement;

    private _information: Information;

    private _bindOnQueue = this._onQueue.bind(this);

    constructor() {
        super();

        this._content.append(getTemplateNode('mcs-simulate-template'));

        this._plotter = getElementFromFragment(this._content, 'mcs-plotter', 'mcs-plotter');
        this._targetSelection = getElementFromFragment(
            this._content,
            'mcs-target-selection',
            'mcs-target-selection'
        );

        this._skill = getElementFromFragment(this._content, 'mcs-skill', 'mcs-dropdown');
        this._plotType = getElementFromFragment(this._content, 'mcs-plot-type', 'mcs-dropdown');
        this._time = getElementFromFragment(this._content, 'mcs-time', 'mcs-dropdown');
        this._selectTarget = getElementFromFragment(this._content, 'mcs-select-target', 'mcs-dropdown');
        this._activeTarget = getElementFromFragment(this._content, 'mcs-active-target', 'button');

        this._slayer = getElementFromFragment(this._content, 'mcs-simulate-slayer-task', 'mcs-switch');
        this._inspect = getElementFromFragment(this._content, 'mcs-inspect', 'button');
        this._stopInspect = getElementFromFragment(this._content, 'mcs-stop-inspect', 'button');
    }

    public connectedCallback() {
        this.appendChild(this._content);

        // The seven category quick-toggle icons now live inside the target-selection panel; it wires
        // them to the same plotter toggle methods and hides categories the account is not entitled to.
        this._updateToggles();

        this._updateSelectTarget();

        this._activeTarget.onclick = () => this._plotter._selectActiveTarget();

        this._information = Global.userInterface.main.querySelector('mcs-information.mcs-main-information');

        customElements.upgrade(this._information);

        const skillLocalIds = cloudManager.hasItAEntitlementAndIsEnabled
            ? Global.combatAbyssalSkillLocalIds
            : Global.combatSkillLocalIds;

        this._skill._init({
            search: false,
            label: 'Skill',
            default: Global.stores.plotter.state.selectedSkill,
            options: skillLocalIds.map(name => ({
                text: name,
                value: name
            })),
            onChange: option => this._onSkillChange(option)
        });

        if (
            Global.context.accountStorage.getItem(StorageKey.PlotSkill) !== Global.stores.plotter.state.selectedSkill &&
            skillLocalIds.includes(Global.context.accountStorage.getItem(StorageKey.PlotSkill))
        ) {
            this._skill._select(Global.context.accountStorage.getItem(StorageKey.PlotSkill));
        }

        const plotTypeOptions = Global.stores.plotter.state.plotTypes.map(plotType => ({
            text: plotType.text,
            value: plotType.key
        }));

        this._plotType._init({
            search: false,
            label: 'Plot Type',
            default: Global.stores.plotter.plotType.key,
            options: plotTypeOptions,
            onChange: option => this._onPlotTypeChange(option)
        });

        if (
            Global.context.accountStorage.getItem(StorageKey.PlotType) !== Global.stores.plotter.plotType.key &&
            plotTypeOptions.some(
                plotType => plotType.value === Global.context.accountStorage.getItem(StorageKey.PlotType)
            )
        ) {
            this._plotType._select(Global.context.accountStorage.getItem(StorageKey.PlotType));
        }

        const plotTimeOptions = Global.stores.plotter.state.timeOptions.map(time => ({
            text: time,
            value: time
        }));

        this._time._init({
            search: false,
            label: 'Time',
            default: Global.stores.plotter.timeOption,
            options: plotTimeOptions,
            onChange: option => this._onTimeChange(option)
        });

        if (
            Global.context.accountStorage.getItem(StorageKey.PlotTime) !== Global.stores.plotter.timeOption &&
            plotTimeOptions.some(
                plotTime => plotTime.value === Global.context.accountStorage.getItem(StorageKey.PlotTime)
            )
        ) {
            this._time._select(Global.context.accountStorage.getItem(StorageKey.PlotTime));
        }

        this._updateSkillVisibility();

        this._slayer._toggle(Global.game.combat.player.isSlayerTask);
        this._slayer._on(isChecked => {
            // This flag now only scopes individual (plain) monster sims to being on-task.
            // Slayer-task bars are always simulated on-task; dungeons/strongholds/depths never are.
            // No mutual-exclusion force-toggles: dungeons and slayer tasks may be enabled simultaneously.
            Global.game.combat.player.isSlayerTask = isChecked;

            this._plotter._updateData();
        });

        this._inspect.disabled = true;
        this._stopInspect.style.display = 'none';
        this._inspect.onclick = () => this._onInspect();
        this._stopInspect.onclick = () => this._onStopInspect();

        Global.simulation.onQueue(this._bindOnQueue);
    }

    public disconnectedCallback() {
        Global.simulation.offQueue(this._bindOnQueue);
    }

    public _updateSelectTarget() {
        let targetElements = this._plotter._getTargetElements();

        if (Global.stores.plotter.state.filterTargetDropdown) {
            targetElements = targetElements.filter(item => !item.details.isFiltered);
        }

        const items = [
            { index: -1, name: 'None' },
            ...targetElements.map(({ index, details }) => ({ index, name: details.name }))
        ];

        this._selectTarget._init({
            search: true,
            label: 'Select Target',
            default: '-1',
            options: items.map(({ index, name }) => ({ text: name, value: index.toString() })),
            onChange: option => this._onSelectTarget(option)
        });
    }

    /** Re-sync the target-selection panel checkboxes with the current sim filter state. */
    public _refreshTargetSelection() {
        this._targetSelection?._refresh();
    }

    private _updateToggles() {
        // The category icons + rows live in the panel; sync their pressed/checked state from the
        // plotter's category-toggle flags and the current sim filters.
        this._targetSelection?._syncToggles();
        this._refreshTargetSelection();
    }

    /**
     * The Skill dropdown only chooses which skill's pet/mark odds to plot, so it's meaningless for
     * every other metric — show it only for the Pet% and Mark% plot types.
     */
    private _updateSkillVisibility() {
        const key = Global.stores.plotter.plotType.key;
        this._skill.style.display = key === PlotKey.Pet || key === PlotKey.Mark ? '' : 'none';
    }

    private _onQueue(current: number, total: number) {
        for (const simulate of Array.from(Global.userInterface.main.querySelectorAll('mcs-simulate-buttons'))) {
            simulate._simulateAll.textContent = `Cancel (${current + 1}/${total})`;
        }
    }

    private _onSkillChange(option: DropdownOption) {
        Global.stores.plotter.set({ selectedSkill: option.value });
        Global.context.accountStorage.setItem(StorageKey.PlotSkill, option.value);

        Drops.updatePetChance();
        Drops.updateMarkChance();

        if (Global.stores.plotter.plotType.key === PlotKey.Pet || Global.stores.plotter.plotType.key === PlotKey.Mark) {
            this._plotter._updateData();
        }

        this._information._setPetType(option.text);
        this._information._setMarkType(option.text);
        this._information._update();
    }

    private _onPlotTypeChange(option: DropdownOption) {
        const plotTypeIndex = Global.stores.plotter.state.plotTypes.findIndex(
            plotType => plotType.key === option.value
        );

        Global.stores.plotter.set({ selectedPlotType: plotTypeIndex });
        Global.context.accountStorage.setItem(StorageKey.PlotType, option.value);

        if (Global.stores.plotter.plotType.isTime) {
            this._time.style.display = '';
        } else {
            this._time.style.display = 'none';
        }

        this._updateSkillVisibility();

        if (this._skill._selected) {
            this._information._setPetType(this._skill._selected.text);
            this._information._setMarkType(this._skill._selected.text);
        }

        this._plotter._updateData();
    }

    private _onTimeChange(option: DropdownOption) {
        const timeIndex = Global.stores.plotter.state.timeOptions.findIndex(time => time === option.value);

        Global.stores.plotter.set({ selectedTimeType: timeIndex });
        Global.context.accountStorage.setItem(StorageKey.PlotTime, option.value);

        Drops.updateSignetChance();
        Drops.updatePetChance();
        Drops.updateMarkChance();

        this._plotter._updateData();

        this._information._setUnits(Global.stores.plotter.timeShorthand);
        this._information._update();
    }

    private _onSelectTarget(option: DropdownOption) {
        this._plotter._selectTarget(parseInt(option.value));
    }

    private _onInspect() {
        if (
            Global.stores.plotter.state.isBarSelected &&
            !Global.stores.plotter.barIsMonster(Global.stores.plotter.state.selectedBar)
        ) {
            this._activeTarget.disabled = true;
            this._plotter._viewEntity(Global.stores.plotter.selectedMonsterId);
        }

        this._updateSelectTarget();
    }

    private _onStopInspect() {
        this._activeTarget.disabled = false;
        this._plotter._viewAll();
        this._updateSelectTarget();
    }
}

customElements.define('mcs-simulate', SimulatePage);
