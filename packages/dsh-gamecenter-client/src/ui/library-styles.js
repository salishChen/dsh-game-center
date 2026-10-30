// Scoped to the game center; host navigation and game Documents keep their own themes.
export const LIBRARY_STYLES = `
[data-gamecenter-page] {
  --gc-bg:#171e28;--gc-panel:#1c2735;--gc-surface:#243447;--gc-border:#344456;
  --gc-text:#e2e9ef;--gc-muted:#9aafbf;--gc-accent:#65c8f3;--gc-hover:#304963;
  --dsw-alias-bg-base:var(--gc-bg);--dsw-alias-bg-layer-1:var(--gc-panel);
  --dsw-alias-label-primary:var(--gc-text);--dsw-alias-label-secondary:var(--gc-muted);
  --dsw-alias-border-l3:var(--gc-border);--dsw-alias-accent:#2587ba;
  --dsw-alias-state-error-primary:#ffb5b5;--dsw-alias-state-info-primary:var(--gc-accent);
  background:var(--gc-bg);color:var(--gc-text);font-family:Inter,"Segoe UI","Microsoft YaHei",sans-serif;
  isolation:isolate;container-type:inline-size;font-size:13px;color-scheme:dark;
}
[data-gamecenter-page][data-gamecenter-theme=light] {
  --gc-bg:#e5ebf1;--gc-panel:#f2f5f8;--gc-surface:#dbe5ee;--gc-border:#bdccd8;
  --gc-text:#243748;--gc-muted:#526b80;--gc-accent:#096b9d;--gc-hover:#ccddeb;
  --dsw-alias-state-error-primary:#a72536;color-scheme:light;
}
[data-gamecenter-page] * {box-sizing:border-box}
[data-gamecenter-page] button,[data-gamecenter-page] input,[data-gamecenter-page] select {font:inherit}
[data-gamecenter-page] select {background:var(--gc-bg);color:var(--gc-text);border-color:var(--gc-border);max-width:100%}
[data-gamecenter-page] button {cursor:pointer}
[data-gamecenter-page] button:disabled {cursor:default;opacity:.5}
[data-gamecenter-page] :is(button,input,select,summary):focus-visible {outline:2px solid var(--gc-accent);outline-offset:3px}
[data-gamecenter-page] button {transition:background .15s,border-color .15s,box-shadow .15s}
[data-gamecenter-page] ::-webkit-scrollbar {width:8px;height:8px}
[data-gamecenter-page] ::-webkit-scrollbar-thumb {background:var(--gc-border);border-radius:8px}
.gc-header {padding:16px 24px;border-bottom:1px solid var(--gc-border);background:var(--gc-panel);flex-shrink:0}
.gc-brand {display:flex;align-items:center;gap:12px;min-width:0}
.gc-brand-mark {display:grid;place-items:center;width:38px;height:38px;background:var(--gc-surface);border:1px solid var(--gc-border);border-radius:10px;color:var(--gc-accent)}
.gc-brand h1 {margin:0;font-size:19px;font-weight:650;letter-spacing:1px;color:var(--gc-text)}
.gc-brand small {display:block;margin-top:3px;font-size:9px;letter-spacing:2.5px;color:var(--gc-muted)}
.gc-header-section {margin-left:24px;color:var(--gc-accent);font-size:14px;font-weight:600;letter-spacing:2px;display:flex;align-items:center;gap:8px}
.gc-header-section::before {content:'';width:4px;height:4px;border-radius:50%;background:var(--gc-accent)}
.gc-button {border:1px solid var(--gc-border);background:var(--gc-surface);color:var(--gc-text);padding:9px 14px;border-radius:3px;line-height:1.4;font-weight:500;white-space:nowrap}
.gc-button:hover:not(:disabled) {background:var(--gc-hover);border-color:var(--gc-accent)}
.gc-button-quiet {font-size:12px;background:transparent;color:var(--gc-muted)}
.gc-wallet {position:relative;margin-left:auto;flex-shrink:0;z-index:3}
.gc-wallet summary {display:flex;align-items:center;gap:9px;list-style:none;cursor:pointer;padding:8px 12px;border:1px solid var(--gc-border);border-radius:4px;background:var(--gc-bg)}
.gc-wallet summary::-webkit-details-marker {display:none}
.gc-wallet-symbol {color:var(--gc-accent);font-size:17px}
.gc-wallet-name {font-size:11px;color:var(--gc-muted)}
.gc-wallet strong {font-size:15px;letter-spacing:.5px;font-variant-numeric:tabular-nums}
.gc-wallet-chevron {font-size:10px;color:var(--gc-muted);margin-left:6px}
.gc-wallet-info {position:absolute;top:calc(100% + 8px);right:0;width:300px;max-width:calc(100vw - 40px);padding:16px;background:var(--gc-panel);border:1px solid var(--gc-border);border-radius:5px;box-shadow:0 8px 28px #0005;font-size:12px;line-height:1.8;color:var(--gc-muted)}
.gc-wallet-info p {margin:0 0 6px}
.gc-wallet-info p:last-child {margin:8px 0 0;padding-top:8px;border-top:1px solid var(--gc-border)}
.gc-library {display:grid;grid-template-columns:204px minmax(0,1fr);height:100%;min-height:0;overflow:hidden}
.gc-sidebar {display:flex;flex-direction:column;padding:22px 12px 16px;border-right:1px solid var(--gc-border);background:var(--gc-panel);overflow:auto;min-height:0}
.gc-sidebar-heading {display:flex;align-items:center;justify-content:space-between;padding:0 10px 18px;font-size:14px;font-weight:600}
.gc-count {color:var(--gc-muted);font-size:11px;font-weight:400;font-variant-numeric:tabular-nums}
.gc-search {display:flex;align-items:center;gap:8px;margin:0 2px 15px;padding:8px 10px;background:var(--gc-bg);border:1px solid var(--gc-border);border-radius:3px;color:var(--gc-muted)}
.gc-search>span {font-size:20px;line-height:16px}
.gc-search:focus-within {border-color:var(--gc-accent)}
.gc-search input {min-width:0;width:100%;padding:0;background:none;border:0;color:var(--gc-text);font-size:12px;outline:none!important}
.gc-search input::placeholder {color:var(--gc-muted)}
.gc-category {display:flex;flex-direction:column;gap:7px;margin:12px 2px;color:var(--gc-muted);font-size:12px}.gc-category select {min-width:0;width:100%;padding:9px;background:var(--gc-bg);border:1px solid var(--gc-border);border-radius:3px;color:var(--gc-text);font:inherit}.gc-category:focus-within select {outline:2px solid var(--gc-accent)}
.gc-filters {display:flex;flex-direction:column;gap:3px}
.gc-filters button {display:flex;align-items:center;gap:10px;text-align:left;padding:10px 12px;color:var(--gc-muted);border:0;border-left:2px solid transparent;border-radius:2px;background:none;font-size:13px}
.gc-filters button>.gc-count {margin-left:auto}
.gc-filters button:hover,.gc-game-link:hover {background:var(--gc-surface)}
.gc-filters button.is-active {color:var(--gc-text);background:var(--gc-surface);border-left-color:var(--gc-accent)}
.gc-sidebar-divider {height:1px;min-height:1px;background:var(--gc-border);margin:20px 10px}
.gc-overline {font-size:10px;letter-spacing:1.6px;color:var(--gc-muted);margin:0 0 8px;font-weight:500}
.gc-sidebar>.gc-overline {padding:0 10px}
.gc-sidebar-games {display:flex;flex-direction:column;gap:4px}
.gc-game-link {display:flex;align-items:center;gap:9px;padding:8px;border:1px solid transparent;background:none;border-radius:3px;color:var(--gc-muted);text-align:left;min-width:0}
.gc-game-link>span:last-child {min-width:0}
.gc-game-link.is-active {color:var(--gc-text);background:var(--gc-surface);border-color:var(--gc-border)}
.gc-link-title {display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:550}
.gc-game-link small {display:block;font-size:10px;color:var(--gc-muted);margin-top:3px}
.gc-mini-art {width:32px;height:32px;border-radius:3px;overflow:hidden;flex-shrink:0}
.gc-mini-art .gc-art-vector {width:55px;max-width:none;margin-left:-12px}
.gc-sidebar-foot {margin-top:auto;padding:28px 10px 0;color:var(--gc-muted);font-size:11px;line-height:1.6}
.gc-sidebar-foot small {display:block;font-size:10px;margin-top:5px}
.gc-connection-dot {display:inline-block;width:5px;height:5px;margin-right:6px;background:#91bd69;border-radius:50%}
.gc-library-main {overflow:auto;padding:25px 30px 16px;min-width:0;background:radial-gradient(ellipse at 65% 0%,#27405d55,transparent 65%),var(--gc-bg)}
.gc-library-heading {display:flex;align-items:center;justify-content:space-between;gap:14px;margin-bottom:20px}
.gc-library-heading h2 {margin:0;font-size:25px;font-weight:500;letter-spacing:2px}
.gc-library-heading .gc-overline {font-size:9px;letter-spacing:2px;margin-bottom:5px}
.gc-alert {border:1px solid #9e824647;background:#bb8c2312;color:var(--gc-muted);padding:9px 12px;font-size:12px;border-radius:3px;margin-bottom:14px;line-height:1.6}
.gc-alert-error {border-color:#ae5369;background:#a8264117;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}
.gc-catalog-note {margin:0 0 14px;color:var(--gc-muted);font-size:12px}
.gc-feature {position:relative;overflow:hidden;min-height:340px;isolation:isolate;border:1px solid #455c704f;border-radius:5px;background:#152938;box-shadow:0 12px 30px #0003;color:#edf3f7}
.gc-art {height:100%;width:100%;position:relative;overflow:hidden;display:flex;align-items:center;justify-content:center;background:radial-gradient(ellipse at 60% 40%,#32676c,#15303b 75%)}
.gc-art-cards {background:radial-gradient(ellipse at 60% 40%,#5a4771,#202c4b 75%)}
.gc-art-mines {background:radial-gradient(ellipse at 60% 40%,#2f6367,#133440 75%)}
.gc-art-flasher {background:radial-gradient(ellipse at 60% 40%,#5b1a1a,#1e0808 75%)}
.gc-art-other {background:radial-gradient(ellipse at 60% 40%,#31567d,#182c49 75%)}
.gc-art::before {content:'';position:absolute;inset:0;background:repeating-linear-gradient(120deg,transparent,transparent 38px,#b1d2dd04 39px,#b1d2dd04 40px);pointer-events:none}
.gc-art-orbit {position:absolute;width:70%;aspect-ratio:1;max-width:390px;border:1px solid #b0d5de1c;border-radius:50%;box-shadow:0 0 0 30px #a0c6db05,0 0 0 65px #a0c6db04}
.gc-art-vector {position:relative;width:100%;max-width:560px;height:auto;filter:drop-shadow(0 16px 12px #0005)}
.gc-feature-art {position:absolute;inset:0 0 0 auto;width:70%}
.gc-feature-art .gc-art-vector {width:90%;margin-left:15%;transform:rotate(-3deg)}
.gc-feature-shade {position:absolute;inset:0;background:linear-gradient(90deg,#142433 3%,#142433e6 31%,#14243340 72%,#14243308)}
.gc-feature-content {position:relative;max-width:590px;padding:29px 32px 30px;width:70%}
.gc-feature-badges {display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:22px}
.gc-badge {padding:4px 8px;background:#b6d1de17;border:1px solid #bdd5e21a;border-radius:2px;font-size:10px;line-height:1.2;color:#b9cfdb}
.gc-badge-preview {color:#e7c38b;background:#ae7e2c26;border-color:#dbad562b}
.gc-badge-ready {color:#b9d897;background:#7a9b3826;border-color:#acc3732b}
.gc-feature-eyebrow {color:#84c5d6;font-size:10px;letter-spacing:2.2px;margin:0 0 9px;line-height:1.5}
.gc-feature h3 {margin:0 0 13px;font-size:clamp(25px,3cqw,39px);font-weight:700;letter-spacing:2px;line-height:1.2;overflow-wrap:anywhere;text-shadow:0 3px 14px #0005}
.gc-feature-description {font-size:12px;line-height:1.9;margin:0;color:#b0c6d5;max-width:380px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.gc-tags {display:flex;flex-wrap:wrap;gap:5px;margin-top:13px}
.gc-tags span {font-size:10px;color:#b7cbd8;background:#a2c6dd14;border-radius:2px;padding:3px 7px}
.gc-play-row {display:flex;align-items:center;gap:16px;margin-top:24px}
.gc-play {display:flex;align-items:center;justify-content:center;gap:12px;min-width:148px;min-height:44px;border:1px solid #a8cb6c66;color:#f3f8ed;background:linear-gradient(100deg,#75a631,#527d23);font-size:15px;font-weight:600;box-shadow:0 3px 12px #0003;padding:10px 20px}
.gc-play:hover:not(:disabled) {background:linear-gradient(100deg,#8bbb42,#679d2b);border-color:#c6e99b}
.gc-play:disabled {color:#ccd7e1;background:#344455;border-color:#556474}
.gc-version {font-size:11px;line-height:1.6;color:#c1d1dc}
.gc-version small {display:block;color:#91a8b8;font-size:10px;white-space:normal}
.gc-button-danger {background:#8c2535;border-color:#be3c51;color:#fff}
.gc-button-danger:hover:not(:disabled) {background:#a82d41;border-color:#db4b63}
.gc-uninstall-confirm {position:absolute;inset:0;background:rgba(15,23,36,0.92);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;z-index:10;padding:20px;border-radius:5px}
.gc-uninstall-dialog-content {background:var(--gc-panel);border:1px solid var(--gc-border);border-radius:6px;padding:20px 24px;max-width:440px;box-shadow:0 12px 36px rgba(0,0,0,0.5)}
.gc-uninstall-dialog-content h4 {margin:0 0 10px;font-size:16px;color:var(--gc-text)}
.gc-uninstall-dialog-content p {margin:0 0 18px;font-size:12px;line-height:1.6;color:var(--gc-muted)}
.gc-uninstall-dialog-actions {display:flex;justify-content:flex-end;gap:10px}
.gc-collection {margin-top:27px}
.gc-section-heading {display:flex;align-items:center;gap:12px;margin-bottom:14px}
.gc-section-heading h3 {margin:0;font-weight:500;font-size:14px;letter-spacing:1px;white-space:nowrap}
.gc-section-heading::after {content:'';height:1px;background:var(--gc-border);flex:1}
.gc-section-heading>span {color:var(--gc-muted);font-size:10px}
.gc-game-grid {display:grid;grid-template-columns:repeat(auto-fill,216px);justify-content:start;gap:16px}
.gc-game-card {display:flex;flex-direction:column;width:216px;min-width:216px;max-width:216px;padding:0;border:1px solid var(--gc-border);border-radius:4px;overflow:hidden;text-align:left;background:var(--gc-panel);color:var(--gc-text);box-shadow:0 4px 12px #0002}
.gc-game-card:hover {border-color:var(--gc-accent);box-shadow:0 6px 20px #0004}
.gc-game-card.is-selected {border-color:var(--gc-accent);box-shadow:0 0 0 1px #65c8f333}
.gc-card-cover {position:relative;width:100%;aspect-ratio:1.95;overflow:hidden}
.gc-card-cover .gc-art-vector {width:88%;max-height:180px}
.gc-art-cover-wrap {position:relative;width:100%;height:100%;overflow:hidden;background:#101a25;display:flex;align-items:center;justify-content:center}
.gc-cover-image {width:100%;height:100%;object-fit:cover;display:block;transition:transform .2s ease}
.gc-game-card:hover .gc-cover-image {transform:scale(1.05)}
.gc-feature-art.gc-art-cover-wrap {width:70%;height:100%;position:absolute;inset:0 0 0 auto;overflow:hidden}
.gc-feature-art .gc-cover-image {width:100%;height:100%;object-fit:cover;opacity:.65;mask-image:linear-gradient(to right,transparent,black 30%);-webkit-mask-image:linear-gradient(to right,transparent,black 30%)}
.gc-card-label {position:absolute;left:10px;top:10px;font-size:9px;background:#142433d9;color:#c6e0cc;border:1px solid #b0d6d126;padding:3px 6px;border-radius:2px}
.gc-preview-label {color:#e7c38b}
.gc-card-copy {padding:12px 14px;width:100%}
.gc-card-copy strong {display:block;font-size:14px;line-height:1.5;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gc-card-copy>span {display:block;color:var(--gc-muted);font-size:10px;margin-top:5px}
.gc-card-bottom {display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:14px;color:var(--gc-muted)}
.gc-card-bottom small {font-size:10px}
.gc-card-bottom>span {font-size:10px;color:var(--gc-accent)}
.gc-details {margin-top:22px;border-top:1px solid var(--gc-border);padding:14px 0;color:var(--gc-muted);font-size:12px}
.gc-details summary {cursor:pointer;width:fit-content}
.gc-details-body {padding:14px 0 0;font-size:12px;line-height:1.8;overflow-wrap:anywhere}
.gc-details-body p {margin:0 0 10px}
.gc-details dl {margin:12px 0 0;display:grid;gap:4px}
.gc-details dl>div {display:flex;gap:16px}
.gc-details dt {flex-shrink:0;min-width:50px}
.gc-details dd {margin:0;color:var(--gc-text);word-break:break-all}
.gc-library-footer {display:flex;flex-wrap:wrap;justify-content:space-between;gap:6px;padding:8px 0;color:var(--gc-muted);font-size:10px}
.gc-empty {padding:45px 20px;text-align:center;border:1px dashed var(--gc-border);border-radius:4px;color:var(--gc-muted);line-height:1.7}
.gc-empty>span {font-size:32px;color:var(--gc-accent)}
.gc-empty h3 {color:var(--gc-text);font-size:17px;margin:10px 0}
.gc-empty p {font-size:12px;margin-bottom:20px}
.gc-running-toolbar {margin:12px 18px 0;color:var(--gc-muted);font-size:12px;gap:10px}
.gc-running-toolbar button {background:var(--gc-surface);color:var(--gc-text);border:1px solid var(--gc-border);border-radius:3px;padding:5px 10px}
.gc-runtime {padding:10px 12px 12px}
.gc-runtime-controls {border:1px solid var(--gc-border)}
.gc-runtime-controls>div:last-child {flex-wrap:wrap;min-width:0}
[data-gamecenter-ai-selector] {max-width:100%;min-width:0}
[data-gamecenter-ai-selector] label {display:flex;align-items:center;flex-wrap:wrap;gap:5px;max-width:100%;min-width:0}
[data-gamecenter-ai-selector] [role=status] {font-size:11px;overflow-wrap:anywhere}
.gc-runtime-info {position:relative;color:var(--gc-muted);font-size:11px}
.gc-runtime-info summary {cursor:pointer;list-style:none;padding:6px}
.gc-runtime-info-popover {position:absolute;z-index:3;top:100%;right:0;min-width:180px;background:var(--gc-panel);border:1px solid var(--gc-border);padding:12px;border-radius:4px;box-shadow:0 6px 20px #0004}
.gc-runtime-info-popover p {margin:0 0 10px}
[data-gamecenter-page-content]>[role=status],[data-gamecenter-page-content]>[aria-live] {margin:12px 18px 0!important;font-size:12px}
@container (min-width:1500px) {.gc-library-main {padding-left:48px;padding-right:48px}.gc-feature {min-height:390px}.gc-feature-content {padding:40px 40px}.gc-game-grid {grid-template-columns:repeat(auto-fill,216px);justify-content:start}}
@container (max-width:1050px) {.gc-library {grid-template-columns:180px minmax(0,1fr)}.gc-library-main {padding:22px 20px 16px}.gc-feature-content {padding:24px;width:80%}.gc-feature-art {width:80%;opacity:.7}.gc-feature-shade {background:linear-gradient(90deg,#142433,#142433d9 37%,#14243322)}.gc-header-section {display:none}.gc-game-grid {gap:12px;grid-template-columns:repeat(auto-fill,216px);justify-content:start}}
@container (max-width:720px) {.gc-header {padding:12px 16px;gap:10px!important}.gc-brand h1 {font-size:17px}.gc-brand small {display:none}.gc-brand-mark {width:32px;height:32px}.gc-wallet-name {display:none}.gc-wallet summary {padding:7px 9px;gap:6px}.gc-header>[data-gamecenter-action=diagnostics] {font-size:11px;padding:8px}.gc-library {grid-template-columns:minmax(0,1fr);grid-template-rows:auto minmax(0,1fr)}.gc-sidebar {padding:12px 16px;border-right:0;border-bottom:1px solid var(--gc-border);overflow:visible;display:grid;grid-template-columns:minmax(110px,1fr) auto;gap:10px}.gc-category {grid-column:1/-1;margin:0}.gc-sidebar-heading,.gc-sidebar-divider,.gc-sidebar>.gc-overline,.gc-sidebar-games,.gc-sidebar-foot {display:none}.gc-search {margin:0;align-self:center;padding:9px}.gc-filters {flex-direction:row;align-items:center;gap:3px}.gc-filters button {padding:8px;font-size:11px;border-left:0;border-bottom:2px solid transparent;gap:5px}.gc-filters button.is-active {border-left:0;border-bottom-color:var(--gc-accent)}.gc-filters button>span:first-child {display:none}.gc-library-main {padding:20px 16px 12px}.gc-library-heading {margin-bottom:16px}.gc-library-heading h2 {font-size:22px}.gc-feature {min-height:320px}.gc-feature-content {width:85%;padding:24px}.gc-feature h3 {font-size:28px}.gc-feature-description {max-width:290px}.gc-feature-art {width:100%;opacity:.65}.gc-play-row {gap:12px}.gc-play {min-width:128px;font-size:14px}.gc-version small {max-width:120px}.gc-game-grid {grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.gc-card-copy {padding:11px}.gc-card-copy strong {font-size:13px}.gc-card-cover {aspect-ratio:1.55}.gc-runtime {padding:0 10px 10px}.gc-running-toolbar {margin:10px 10px 0}}
@container (max-width:440px) {.gc-header {gap:8px!important}.gc-brand {gap:7px}.gc-brand-mark {display:none}.gc-brand h1 {font-size:16px;letter-spacing:0}.gc-header>[data-gamecenter-action=diagnostics] {font-size:10px;padding:7px}.gc-wallet strong {font-size:12px}.gc-wallet-symbol {font-size:13px}.gc-wallet-chevron {display:none}.gc-sidebar {grid-template-columns:minmax(0,1fr);gap:8px}.gc-filters {justify-content:space-between}.gc-filters button {flex:1;justify-content:center}.gc-filters button>.gc-count {margin-left:0}.gc-feature-content {width:100%;padding:22px 20px}.gc-feature-art {opacity:.4}.gc-feature-shade {background:linear-gradient(90deg,#142433ed,#14243360)}.gc-feature-badges {margin-bottom:20px}.gc-feature h3 {font-size:27px}.gc-feature-description {max-width:100%}.gc-tags {gap:4px}.gc-feature-eyebrow {font-size:9px}.gc-card-label {top:6px;left:6px;font-size:8px}.gc-card-bottom>span {font-size:9px}.gc-library-footer {font-size:9px}}
@media (prefers-reduced-motion:reduce) {[data-gamecenter-page] button {transition:none}}
.gc-pagination {display:flex;align-items:center;justify-content:center;gap:14px;margin-top:20px;padding:12px 0;border-top:1px solid var(--gc-border);font-size:12px;color:var(--gc-muted)}
.gc-page-btn {background:var(--gc-surface);color:var(--gc-text);border:1px solid var(--gc-border);border-radius:3px;padding:5px 12px;font:inherit;cursor:pointer}
.gc-page-btn:hover:not(:disabled) {border-color:var(--gc-accent);background:var(--gc-hover)}
.gc-page-btn:disabled {opacity:.35;cursor:default}
.gc-page-info {font-variant-numeric:tabular-nums}

.gc-arena-portrait{display:block;background-size:300% 200%;background-repeat:no-repeat;aspect-ratio:1;flex-shrink:0;border-radius:8px}
.gc-opponent-dialog{width:min(960px,calc(100vw - 32px));max-height:calc(100vh - 36px);overflow:auto;background:var(--gc-panel);color:var(--gc-text);border:1px solid var(--gc-border);border-radius:10px;padding:26px;box-shadow:0 20px 70px #0008}
.gc-opponent-dialog::backdrop{background:#09111de8}.gc-opponent-dialog h2{font-size:26px;margin:6px 0 10px}.gc-opponent-intro{color:var(--gc-muted);font-size:13px;line-height:1.7}.gc-opponent-grid{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:12px;margin:24px 0}.gc-opponent-card{padding:0 0 13px;background:var(--gc-bg);color:var(--gc-text);border:1px solid var(--gc-border);border-radius:7px;overflow:hidden;text-align:center}.gc-opponent-card.is-selected{border-color:var(--gc-accent);box-shadow:0 0 0 1px var(--gc-accent)}.gc-opponent-card .gc-arena-portrait{width:100%;border-radius:0}.gc-opponent-card strong{display:block;font-size:16px;margin:12px 0 3px}.gc-opponent-card span:not(.gc-arena-portrait){display:block;font-size:11px;color:var(--gc-muted)}.gc-opponent-card small{display:block;font-size:10px;margin:10px 0 0;color:var(--gc-muted)}.gc-opponent-card:disabled{opacity:.6}.gc-opponent-config{display:flex;gap:18px;flex-wrap:wrap;padding:16px;background:var(--gc-bg);border:1px solid var(--gc-border);border-radius:5px}.gc-opponent-config label{display:flex;align-items:center;gap:10px;font-size:12px;max-width:100%;flex-wrap:wrap}.gc-opponent-config select{padding:8px;border:1px solid var(--gc-border);border-radius:3px}.gc-opponent-actions{display:flex;justify-content:space-between;gap:12px;margin-top:24px}.gc-opponent-error{color:var(--dsw-alias-state-error-primary);font-size:12px}.gc-arena-opponent-current{display:flex;align-items:center;gap:8px;font-size:12px;flex-wrap:wrap}.gc-arena-opponent-current .gc-arena-portrait{width:34px;border-radius:50%;border:1px solid var(--gc-border)}.gc-arena-opponent-current small{display:block;font-size:10px;color:var(--gc-muted);max-width:300px;overflow-wrap:anywhere}
@media(max-width:760px){.gc-opponent-grid{grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.gc-opponent-dialog{padding:18px}.gc-opponent-card strong{font-size:14px}.gc-opponent-actions .gc-play{min-width:0;font-size:12px;padding:10px}.gc-opponent-config{padding:12px;gap:12px}.gc-opponent-dialog h2{font-size:22px}}

.gc-runtime-controls{padding:5px 10px!important;min-height:44px;border-radius:7px!important}.gc-runtime{gap:4px!important}.gc-runtime-controls .gc-button{padding:5px 9px;min-height:30px}.gc-runtime-controls .gc-arena-opponent-current .gc-arena-portrait{width:30px}.gc-runtime-controls .gc-whale-wallet{margin:0}@media(min-width:1000px){.gc-runtime-controls{flex-wrap:nowrap!important}.gc-runtime-controls>div{flex-wrap:nowrap!important}.gc-arena-opponent-current{flex-wrap:nowrap}.gc-arena-opponent-current small{max-width:230px;white-space:nowrap;text-overflow:ellipsis;overflow:hidden}}
`;
