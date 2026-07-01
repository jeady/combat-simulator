/**
 * In-memory fakes for headless optimizer tests. A `FakeWorld` holds the equipped items and
 * each item's deterministic `power`/`risk`; the applier mutates it and the scorer reads it,
 * so optima are known by construction. No game/`Global.*` dependency.
 */
import {
    CancelToken,
    CandidateProvider,
    EquipmentLoadout,
    Evaluation,
    LoadoutApplier,
    OptimizeTarget,
    Scorer,
    SlotRef
} from 'src/app/optimizer/types';

export interface FakeItem {
    id: string;
    slotId: string;
    /** Contributes to the metric (higher = stronger). */
    power: number;
    /** Contributes to death rate (summed across equipped items, clamped to 0..1). */
    risk?: number;
    /** Slots emptied when this item is equipped (e.g. a 2H weapon clearing the shield slot). */
    clearsSlots?: string[];
}

export class FakeWorld {
    public current: EquipmentLoadout = new Map();
    private readonly items = new Map<string, FakeItem>();
    private readonly bySlot = new Map<string, string[]>();
    public readonly slotIds: string[];

    constructor(slotIds: string[], items: FakeItem[], start: Record<string, string> = {}) {
        this.slotIds = slotIds;
        for (const item of items) {
            this.items.set(item.id, item);
            const list = this.bySlot.get(item.slotId) ?? [];
            list.push(item.id);
            this.bySlot.set(item.slotId, list);
        }
        for (const [slotId, itemId] of Object.entries(start)) {
            this.current.set(slotId, itemId);
        }
    }

    public item(id: string): FakeItem | undefined {
        return this.items.get(id);
    }

    public candidates(slotId: string): string[] {
        return this.bySlot.get(slotId) ?? [];
    }

    /** Total power of all equipped items (the maximize metric). */
    public power(): number {
        let total = 0;
        for (const itemId of this.current.values()) {
            total += this.items.get(itemId)?.power ?? 0;
        }
        return total;
    }

    public deathRate(): number {
        let risk = 0;
        for (const itemId of this.current.values()) {
            risk += this.items.get(itemId)?.risk ?? 0;
        }
        return Math.max(0, Math.min(1, risk));
    }
}

export class FakeApplier implements LoadoutApplier {
    constructor(private readonly world: FakeWorld) {}

    public snapshot(): unknown {
        return new Map(this.world.current);
    }

    public restore(snap: unknown): void {
        this.world.current = new Map(snap as EquipmentLoadout);
    }

    public slots(): SlotRef[] {
        return this.world.slotIds.map(id => ({ id }));
    }

    public getCurrentLoadout(): EquipmentLoadout {
        return new Map(this.world.current);
    }

    public applyLoadout(loadout: EquipmentLoadout): void {
        this.world.current = new Map(loadout);
    }

    public unequip(slotId: string): void {
        this.world.current.delete(slotId);
    }

    public equip(slotId: string, itemId: string): void {
        const item = this.world.item(itemId);
        // Forward: the new item clears the slots it occupies (e.g. a 2H weapon clears the shield).
        for (const cleared of item?.clearsSlots ?? []) {
            this.world.current.delete(cleared);
        }
        // Reverse: filling this slot unequips any item that itself clears this slot, so 2H<->shield
        // is mutually exclusive (mirrors real `equipItem` occupies-slot semantics).
        for (const [equippedSlot, equippedId] of [...this.world.current]) {
            if (this.world.item(equippedId)?.clearsSlots?.includes(slotId)) {
                this.world.current.delete(equippedSlot);
            }
        }
        this.world.current.set(slotId, itemId);
    }
}

export class FakeCandidateProvider implements CandidateProvider {
    constructor(private readonly world: FakeWorld) {}
    public getCandidates(slotId: string): string[] {
        return this.world.candidates(slotId);
    }
}

export interface FakeScorerOptions {
    maximize?: boolean;
    /** Invoked before each evaluation with the running count; use to trigger cancellation. */
    onEvaluate?: (count: number) => void;
}

export class FakeScorer implements Scorer {
    public evaluations = 0;
    public lastTrials = 0;
    /** The death-abort threshold the optimizer passed on the most recent evaluation. */
    public lastDeathAbortThreshold: number | undefined = undefined;
    /** Every death-abort threshold seen, in call order (search evals + the final re-score). */
    public readonly deathAbortThresholds: (number | undefined)[] = [];
    constructor(private readonly world: FakeWorld, private readonly opts: FakeScorerOptions = {}) {}

    public async evaluate(
        _target: OptimizeTarget,
        trials: number,
        _ticks: number,
        deathAbortThreshold?: number
    ): Promise<Evaluation> {
        this.evaluations++;
        this.lastTrials = trials;
        this.lastDeathAbortThreshold = deathAbortThreshold;
        this.deathAbortThresholds.push(deathAbortThreshold);
        this.opts.onEvaluate?.(this.evaluations);
        return { metric: this.world.power(), deathRate: this.world.deathRate(), success: true };
    }

    public isMaximize(): boolean {
        return this.opts.maximize ?? true;
    }
}

export function cancelToken(): CancelToken {
    return { cancelled: false };
}

export const TARGET: OptimizeTarget = { monsterId: 'test:Dummy' };
