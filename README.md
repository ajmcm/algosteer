# AlgoSteer (beta)

A Chrome extension that adds a personal preference layer to your LinkedIn feed.
Click **More** or **Less** on posts; AlgoSteer learns which posts to show or hide.
Inference and preference learning run locally on your device.

## Why I built it

I wanted to spend less time sifting through crap and more time finding posts
that were interesting or genuine. AI slop, lazy posts and recycled takes take
up attention I'd rather give to something thoughtful, useful or unexpected.
I wanted a feed that could learn my particular interests from my own feedback.

AlgoSteer started as a question: could I give the user more control over their
own algorithm? The platform still chooses which posts reach the feed, but a
personal preference layer gives me a say in what gets my attention once it's
there.

I also wanted room to be surprised. A filter that keeps narrowing around what
I've already liked could shut out new subjects and perspectives. That's why
AlgoSteer includes exploration: uncertain posts get a chance to challenge its
current view of my tastes. It can only explore within the feed it receives,
so this is a design goal rather than a guarantee of escaping a bubble.

Finally, my interests change. I wanted the model to leave room for that too,
using time-aware uncertainty and fresh feedback so earlier ratings don't
become a permanent definition of what I want to see.

## Install from source

Requires Node.js 22 or newer, npm, and Chrome 120 or newer. Internet access is
needed to install dependencies and download embedding weights on first use.

Clone this repository or download it using **Code → Download ZIP**. Open a
terminal in the project folder, then run:

```sh
npm ci
npm test
npm run build
```

In Chrome:

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select this project's `dist/` folder.
3. Open or refresh the LinkedIn feed.
4. Use **More** and **Less** to provide ratings. Open the extension popup for settings.

On macOS, `build.command` can also install dependencies, test and build.
The source repository excludes `dist/`; every checkout builds its own extension.

### Upgrade an existing installation

Keep your current project folder and unpacked extension entry. Build in that
folder, click **Reload** on the existing entry in `chrome://extensions`, then
refresh LinkedIn. The current version is **0.1.8**.

Saved ratings, embeddings, timestamps and settings use the same Chrome storage
keys. The 512-feature classifier rebuilds from saved embeddings without a label
reset. Keep the existing unpacked path: removing the extension deletes its local
storage, and loading a different folder may create another extension ID.

## How it works

```text
Post text → frozen encoder → normalized embedding → 512 RFFs + intercept
          → dynamic Bayesian logistic head → show/hide + capped exploration
                                         ↑
                                explicit More/Less ratings
```

- **Representation:** a frozen text encoder produces semantic embeddings.
  Seeded random Fourier features approximate an RBF kernel with lengthscale 0.72,
  allowing a nonlinear boundary without fine-tuning the encoder.
- **Preference model:** logistic likelihood with a Gaussian weight prior and a
  full 513 × 513 covariance. Sequential scalar Laplace assumed-density updates
  maintain an approximate Gaussian posterior; this is approximate Bayesian inference.
- **Changing tastes:** a Gaussian random walk adds weight covariance in proportion
  to elapsed calendar time. The popup controls drift; the default standard
  deviation is 0.12 per square-root week. Saved ratings remain available for replay.
- **Prediction:** posterior logit mean and variance give an approximate predictive
  probability. The displayed range transforms ±1.96 latent standard deviations;
  it is a model uncertainty interval, not a calibrated guarantee about a binary rating.
- **Exploration:** above-threshold posts are shown. For below-threshold posts,
  a gate (default 8%) permits a posterior sample; the post is shown if that
  sample exceeds the preference threshold. Exposure from this step is capped by
  the gate probability. Optional ratings mean standard bandit regret guarantees
  do not automatically apply.

Learning uses explicit ratings only. Scrolling, dwell time, clicking, expanding
and leaving a post unrated do not generate training labels.

### Embedding model

AlgoSteer uses **EmbeddingGemma 2**, a frozen text encoder with 768-dimensional
embeddings, quantized ONNX weights and local WebGPU inference. It downloads the
text encoder only, without unused vision or audio weights. A WebGPU-compatible
Chrome device is required.

Model assets come from
[onnx-community/embeddinggemma-2-ONNX](https://huggingface.co/onnx-community/embeddinggemma-2-ONNX).
The model card specifies the applicable model terms.

Saved ratings from an older encoder are retained and re-embedded locally when
next scoring or rating a post. The replacement dataset is saved only after all
embeddings succeed. A failed upgrade leaves the stored dataset intact and can
be retried; there is no need to clear ratings.

## Using the beta

- Automatic filtering begins after at least **12 ratings**, including **3 More**
  and **3 Less**. Before that, unrated posts remain visible.
- Explicit **More** keeps a rated post visible; **Less** hides it while filtering
  is enabled. Hidden posts can be reviewed and revealed from the feed controls.
- Adjust the preference threshold (default 38%), exploration cap and drift in
  the popup. Pause filtering at any time.
- **Export labelled text** saves text, ratings and timestamps to JSON. It excludes
  embeddings and is not a complete instant-restore backup.
- **Clear all labels** permanently deletes local rating history.

## Privacy and permissions

Post text is embedded locally. Rated text, embeddings, labels and timestamps are
saved in `chrome.storage.local`. Unrated text is not persisted by the extension;
unrated embeddings are cached temporarily in service-worker memory.

Hugging Face receives requests to download model assets. Post text is not sent to
an inference service. Runtime JavaScript and WASM are bundled into the extension.
Permissions cover LinkedIn page access, model-download hosts, local storage
(including `unlimitedStorage`), and an offscreen inference document.

## Development

```sh
npm ci
npm test
npm run build
```

Tests cover the classifier, sampling policy and startup using existing saved
ratings without rewriting history. The build verifies paired local ONNX Runtime
`.mjs` and `.wasm` assets. GitHub Actions runs tests and a build on Node.js 22.
A live Chrome/LinkedIn check remains manual; unit tests and a successful build
cannot establish that LinkedIn's current markup works on every account.

| Path | Purpose |
|---|---|
| `src/engine.mjs` | RFF map, Bayesian updates, time diffusion and exploration |
| `src/background.js` | Stored ratings/settings, embedding orchestration and scoring |
| `src/offscreen.js` | Local text encoder inference |
| `src/content.js`, `src/content.css` | Feed detection, rating and review controls |
| `src/popup.*` | Settings and export UI |
| `scripts/build.mjs` | Bundle the extension into `dist/` |
| `tests/` | Node test suite |

## Troubleshooting and limitations

- **No controls:** reload the existing extension and refresh LinkedIn. Check the
  page console for `[AlgoSteer]` messages. LinkedIn DOM changes can break extraction.
- **Missing inference backend:** rebuild and reload. The build must include both
  ONNX Runtime loader modules and WASM binaries in `dist/wasm/`.
- **WebGPU errors:** confirm WebGPU is enabled and available in Chrome. The
  embedding model requires a compatible GPU/device; there is no CPU fallback.
- **First rating is slow:** model downloads and encoder startup can take time.
- Text-only scoring ignores attached images. Small or selectively rated datasets
  can yield unreliable scores and uncertainty estimates. The 512-feature
  full-covariance model also costs more CPU/memory than smaller heads.

AlgoSteer is an experimental, unofficial extension and is not affiliated with
LinkedIn. It modifies the feed in your browser; review platform terms before use.

## Licensing

A license for AlgoSteer's own source has not been specified. Publishing the
repository does not grant a general license to reuse its code. Third-party
packages and model weights retain their respective licenses.
