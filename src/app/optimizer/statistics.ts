/**
 * Tiny statistics helpers for the optimizer's significance handling. Pure (no game deps).
 */

export interface MeanStdError {
    /** Sample mean of the finite inputs. NaN if there are none. */
    mean: number;
    /** Standard error of the mean (sample sd / √n). NaN if fewer than 2 finite samples. */
    stdError: number;
    /** Count of finite samples used. */
    n: number;
}

/**
 * Mean and standard error of a set of samples (e.g. the objective metric measured over B independent
 * batches — batch means). Non-finite samples are dropped. With fewer than 2 finite samples the
 * standard error is undefined (NaN) — you can't estimate spread from a single point.
 *
 * Uses the sample variance (Bessel's n−1) so the estimate is unbiased; `stdError = sd / √n`.
 */
export function meanStdError(samples: readonly number[]): MeanStdError {
    const valid = samples.filter(Number.isFinite);
    const n = valid.length;
    if (n === 0) {
        return { mean: NaN, stdError: NaN, n: 0 };
    }
    const mean = valid.reduce((sum, x) => sum + x, 0) / n;
    if (n < 2) {
        return { mean, stdError: NaN, n };
    }
    const variance = valid.reduce((sum, x) => sum + (x - mean) ** 2, 0) / (n - 1);
    return { mean, stdError: Math.sqrt(variance / n), n };
}
