/**
 * Frozen normalized embedding -> seeded Gaussian RFF -> Bayesian logistic head.
 * Dynamic Gaussian assumed-density filter: logistic likelihood updates a
 * full-covariance posterior, with a time-aware random-walk state transition.
 * The exact posterior is not Gaussian; each update is an approximation.
 * No rating is inferred from non-interaction.
 */
export const FEATURE_DIM = 512;
export const DEFAULTS = Object.freeze({
  model: 'mini',
  threshold: 0.38,
  exploration: 0.08,
  enabled: true,
  driftStdPerWeek: 0.12, // Weight-space random-walk SD / sqrt(week).
});
export const MODELS = Object.freeze({
  mini: { id: 'Xenova/all-MiniLM-L6-v2', name: 'MiniLM (fast, 23 MB)', dtype: 'q8', device: 'wasm', maxChars: 3400 },
  gemma: { id: 'onnx-community/embeddinggemma-2-ONNX', name: 'EmbeddingGemma 2 (quality, ~175 MB)', dtype: 'q4', device: 'webgpu', maxChars: 6200 },
});

export function sigmoid(x) {
  if (x >= 0) return 1 / (1 + Math.exp(-x));
  const t = Math.exp(x); return t / (1 + t);
}
export function logit(p) { return Math.log(p / (1 - p)); }
export function normalRandom(random = Math.random) {
  const u = Math.max(1e-12, random());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}
export function fnv1a(text) {
  let h = 2166136261;
  for (let i=0; i<text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h,16777619); }
  return (h >>> 0).toString(16).padStart(8,'0');
}
export function normalizeText(text) { return String(text || '').replace(/\s+/g, ' ').trim().slice(0,6200); }
export function makeRandom(seed = 0x4babbeef) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(1664525, s) + 1013904223) >>> 0; return s / 4294967296; };
}

export class FeatureMap {
  constructor(inputDim, featureDim = FEATURE_DIM, lengthscale = 0.72) {
    this.inputDim = inputDim;
    this.featureDim = featureDim;
    this.lengthscale = lengthscale;
    const rng = makeRandom(0x7c52ad1e);
    this.weights = new Float64Array(inputDim * featureDim);
    this.phase = new Float64Array(featureDim);
    for (let j=0; j<featureDim; j++) {
      this.phase[j] = 2 * Math.PI * rng();
      for (let k=0; k<inputDim; k++) this.weights[j*inputDim+k] = normalRandom(rng) / lengthscale;
    }
  }
  transform(embedding) {
    if (!embedding || embedding.length !== this.inputDim) throw new Error('Embedding dimensions changed. Reset or switch model profile.');
    const d = this.featureDim;
    const output = new Float64Array(d + 1);
    for (let j=0; j<d; j++) {
      let dot = this.phase[j];
      const base = j*this.inputDim;
      for (let k=0; k<this.inputDim; k++) dot += this.weights[base+k]*embedding[k];
      output[j] = Math.sqrt(2/d) * Math.cos(dot);
    }
    output[d] = 1; // intercept
    return output;
  }
}

export function cholesky(a, d) {
  const l = new Float64Array(d*d);
  for (let i=0; i<d; i++) for (let j=0; j<=i; j++) {
    let sum = a[i*d+j];
    for (let k=0; k<j; k++) sum -= l[i*d+k]*l[j*d+k];
    if (i===j) {
      if (sum<=0 || !Number.isFinite(sum)) throw new Error('Posterior precision is not positive definite');
      l[i*d+j] = Math.sqrt(sum);
    } else l[i*d+j] = sum/l[j*d+j];
  }
  return l;
}
export function solveLower(l, b) {
  const d=b.length, x=new Float64Array(d);
  for(let i=0;i<d;i++) {
    let s=b[i]; for(let j=0;j<i;j++) s-=l[i*d+j]*x[j];
    x[i]=s/l[i*d+i];
  }
  return x;
}
export function solveCholesky(l,b) {
  const d=b.length, y=solveLower(l,b),x=new Float64Array(d);
  for(let i=d-1;i>=0;i--) {
    let s=y[i];for(let j=i+1;j<d;j++)s-=l[j*d+i]*x[j];
    x[i]=s/l[i*d+i];
  }
  return x;
}
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Time-varying Bayesian logistic RFF classifier.
 *
 * State: w_t = w_(t-1) + noise, noise ~ N(0, q * elapsedWeeks * I).
 * Observation: y_t ~ Bernoulli(sigmoid(phi(x_t)^T w_t)).
 *
 * Each rating applies a scalar-Laplace assumed-density filtering (ADF) update
 * to N(mean, covariance). We replay the stored timestamped labels whenever a
 * rating changes, so this requires no persisted posterior or schema migration.
 *
 * The full covariance is 513 x 513 with the default feature count, and
 * uncertainty in prediction grows naturally with elapsed time since feedback.
 */
export class BayesianRFF {
  constructor(embeddingDim, {
    featureDim = FEATURE_DIM,
    priorPrecision = 1.5,
    driftStdPerWeek = DEFAULTS.driftStdPerWeek,
  } = {}) {
    if (!(priorPrecision > 0)) throw new Error('Prior precision must be positive');
    if (!Number.isFinite(driftStdPerWeek) || driftStdPerWeek < 0 || driftStdPerWeek > 1)
      throw new Error('Invalid drift rate');
    this.map = new FeatureMap(embeddingDim, featureDim);
    this.d = featureDim + 1;
    this.priorPrecision = priorPrecision;
    this.driftStdPerWeek = driftStdPerWeek;
    this.mean = new Float64Array(this.d);
    this.covariance = new Float64Array(this.d * this.d);
    this.lastTimeMs = null;
    this.labels = 0;
    this.positives = 0;
    this.negatives = 0;
    this.resetPosterior();
  }
  sufficient() { return this.labels >= 12 && this.positives >= 3 && this.negatives >= 3; }
  resetPosterior() {
    this.mean.fill(0);
    this.covariance.fill(0);
    for (let j = 0; j < this.d; j++)
      this.covariance[j * this.d + j] = 1 / this.priorPrecision;
    this.lastTimeMs = null;
  }
  // Process uncertainty is proportional to elapsed calendar time, not count
  // of ratings. Never mutate the posterior when merely predicting.
  processVariance(fromMs, toMs) {
    if (fromMs === null || toMs <= fromMs) return 0;
    return this.driftStdPerWeek ** 2 * ((toMs - fromMs) / WEEK_MS);
  }
  advance(toMs) {
    if (this.lastTimeMs !== null) {
      const addedVariance = this.processVariance(this.lastTimeMs, toMs);
      if (addedVariance > 0) {
        for (let j = 0; j < this.d; j++)
          this.covariance[j * this.d + j] += addedVariance;
      }
    }
    this.lastTimeMs = toMs;
  }
  // Scalar Laplace projection: the prior logit a = phi^T w is N(a,s^2).
  // Its tilted posterior mode z solves z = a + s^2(y-sigmoid(z)).
  // Lift that one-dimensional update back into weight space while retaining
  // cross-feature correlations in the full covariance.
  observe(phi, y) {
    const d = this.d, P = this.covariance, mu = this.mean;
    const u = new Float64Array(d);
    let a = 0;
    for (let j = 0; j < d; j++) {
      a += phi[j] * mu[j];
      let total = 0;
      for (let k = 0; k < d; k++) total += P[j * d + k] * phi[k];
      u[j] = total;
    }
    let s2 = 0;
    for (let j = 0; j < d; j++) s2 += phi[j] * u[j];
    if (!(s2 > 0) || !Number.isFinite(s2))
      throw new Error('Dynamic posterior covariance became invalid');

    let z = a;
    for (let iter = 0; iter < 24; iter++) {
      const p = sigmoid(z);
      const step = (z - a - s2 * (y - p)) / (1 + s2 * p * (1 - p));
      z -= step;
      if (Math.abs(step) < 1e-11) break;
    }
    const p = sigmoid(z), curvature = Math.max(0, p * (1 - p));
    const reduction = curvature / (1 + curvature * s2);
    const displacement = (z - a) / s2;
    for (let j = 0; j < d; j++) mu[j] += u[j] * displacement;
    for (let j = 0; j < d; j++) {
      for (let k = 0; k <= j; k++) {
        const updated = P[j * d + k] - reduction * u[j] * u[k];
        P[j * d + k] = updated;
        if (j !== k) P[k * d + j] = updated;
      }
    }
  }
  fit(samples, {nowMs = Date.now()} = {}) {
    if (!Number.isFinite(nowMs)) throw new Error('Invalid current time');
    this.resetPosterior();
    // Preserve chronological order for ratings with identical timestamps.
    // Older releases stored updatedAt; no conversion of existing labels needed.
    const data = samples.map((sample, index) => {
      const parsed = Date.parse(sample.updatedAt || '');
      return {
        phi: this.map.transform(sample.embedding),
        y: sample.label === 1 ? 1 : 0,
        time: Number.isFinite(parsed) ? Math.min(nowMs, Math.max(0, parsed)) : nowMs,
        index,
      };
    }).sort((a, b) => a.time - b.time || a.index - b.index);
    this.labels = data.length;
    this.positives = data.filter(item => item.y === 1).length;
    this.negatives = this.labels - this.positives;
    for (const item of data) {
      this.advance(item.time);
      this.observe(item.phi, item.y);
    }
    // No labels: predictions use the original prior, with no time ageing.
    if (!data.length) this.lastTimeMs = null;
    return this;
  }
  predict(embedding, nowMs = Date.now()) {
    const phi = this.map.transform(embedding), d = this.d;
    let mu = 0, variance = 0, norm2 = 0;
    for (let j = 0; j < d; j++) {
      mu += phi[j] * this.mean[j];
      norm2 += phi[j] * phi[j];
      let component = 0;
      for (let k = 0; k < d; k++) component += this.covariance[j * d + k] * phi[k];
      variance += phi[j] * component;
    }
    // Diffuse state from latest rating until prediction time, without adding
    // fake observations or mutating the stored posterior.
    variance += this.processVariance(this.lastTimeMs, nowMs) * norm2;
    variance = Math.max(0, variance); // protect against roundoff
    const sd = Math.sqrt(variance);
    return {
      probability: sigmoid(mu / Math.sqrt(1 + Math.PI * variance / 8)),
      epistemicSd: sd, // logit-space SD, not probability-space SD
      lower: sigmoid(mu - 1.96 * sd),
      upper: sigmoid(mu + 1.96 * sd),
      logitMean: mu,
      logitVariance: variance,
    };
  }
}

/**
 * Capped Thompson exploration: above threshold -> show; otherwise only
 * run posterior sampling with a configurable small exploration probability.
 * Randomness is not a label. For testing, random() is injectable.
 */
export function decide(prediction, {threshold=DEFAULTS.threshold, exploration=DEFAULTS.exploration}={}, random=Math.random){
  if(prediction.probability>=threshold) return {show:true, reason:'preferred', sampled:null};
  if(random()>=exploration) return {show:false, reason:'filtered', sampled:null};
  const sampled=sigmoid(prediction.logitMean + Math.sqrt(prediction.logitVariance)*normalRandom(random));
  return sampled>=threshold ? {show:true,reason:'thompson',sampled} : {show:false,reason:'filtered',sampled};
}
