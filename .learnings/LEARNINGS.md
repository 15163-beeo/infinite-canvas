## [LRN-20260626-001] correction

**Logged**: 2026-06-26T15:20:00+08:00
**Priority**: medium
**Status**: pending
**Area**: frontend

### Summary
New user-facing tool pages in this project should follow the global light/dark theme instead of hard-coding one palette.

### Details
The first implementation of `web/src/app/(user)/aesthetic-mirror/page.tsx` hard-coded a light beige UI, then was overcorrected to hard-coded dark UI. Both were wrong because the existing 生图工作台 follows the app theme toggle. The corrected page uses light classes with `dark:` variants so it is white in light mode and black/dark gray in dark mode.

### Suggested Action
Before adding new tool surfaces, inspect nearby product pages and pair light classes with `dark:` variants; do not hard-code standalone black or white palettes for the whole page.

### Metadata
- Source: user_feedback
- Related Files: `web/src/app/(user)/aesthetic-mirror/page.tsx`
- Tags: theme-toggle, visual-consistency, tool-page

---

## [LRN-20260626-005] correction

**Logged**: 2026-06-26T17:33:37+08:00
**Priority**: medium
**Status**: resolved
**Area**: frontend

### Summary
Generation history drawers for image tools should prioritize large image previews over metadata-heavy cards.

### Details
The aesthetic mirror history drawer initially showed thumbnails plus title, time, tags, prompt, model, size, and duration. For this workflow the user expects the drawer to be a quick visual recall surface: show the generated images large, with only minimal overlay actions such as delete.

### Suggested Action
For `web/src/app/(user)/aesthetic-mirror/page.tsx`, render history entries as full-width image cards using the generated image aspect ratio. Keep metadata out of the card unless the user explicitly asks for it.

### Metadata
- Source: user_feedback
- Related Files: `web/src/app/(user)/aesthetic-mirror/page.tsx`
- Tags: history, image-gallery, drawer-ui

### Resolution
- **Resolved**: 2026-06-26T17:33:37+08:00
- **Notes**: Replaced detailed history cards with large image-only history previews and hover delete controls.

---

## [LRN-20260626-004] correction

**Logged**: 2026-06-26T17:32:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: frontend

### Summary
Generation history should create a visible in-progress record immediately after starting a long-running task.

### Details
The aesthetic mirror history originally wrote records only after `requestEdit()` completed. During long APIMart runs, opening the history drawer showed "暂无历史记录", which looked broken even though the task was still running.

### Suggested Action
For long-running generation workflows, save a `生成中` history entry before awaiting the API response, then update the same record to `成功` or `失败` when the task completes.

### Metadata
- Source: user_feedback
- Related Files: `web/src/app/(user)/aesthetic-mirror/page.tsx`
- Tags: history, async-generation, ux

### Resolution
- **Resolved**: 2026-06-26T17:32:00+08:00
- **Notes**: 爆款复刻 now saves a pending history record before generation and updates that record on success/failure.

---

## [LRN-20260626-003] correction

**Logged**: 2026-06-26T17:05:00+08:00
**Priority**: high
**Status**: resolved
**Area**: frontend

### Summary
Style-clone image prompts must explicitly lock the uploaded product as the only product subject.

### Details
When the reference image contains a similar product, a prompt that only says "use our product to redesign in a similar style" can cause the model to copy or synthesize the reference product's bottle, label, color, and brand cues. The aesthetic mirror workflow needs the prompt to say the reference image is only for layout/background/visual language and that the product material image must keep its bottle shape, label structure, brand marks, color, and visible details.

### Suggested Action
Keep product-preservation constraints in `basePrompt` for `web/src/app/(user)/aesthetic-mirror/page.tsx`; do not rely only on image order to distinguish reference/product roles.

### Metadata
- Source: user_feedback
- Related Files: `web/src/app/(user)/aesthetic-mirror/page.tsx`
- Tags: prompt-design, product-preservation, style-transfer

### Resolution
- **Resolved**: 2026-06-26T17:05:00+08:00
- **Notes**: Updated the default prompt to state that the reference image only provides layout/background/style and the product material must remain the unique product subject without packaging replacement.

---

## [LRN-20260626-002] correction

**Logged**: 2026-06-26T16:25:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: frontend

### Summary
Image upload previews for the aesthetic mirror page should keep hover actions hidden by default, matching the referenced product UI.

### Details
The reference card interaction shows a clean image preview by default. On hover, it reveals small floating action buttons such as preview and remove. The earlier implementation made remove actions always visible and briefly added a visible "点击替换" overlay, which did not match the target interaction.

### Suggested Action
For upload-preview cards in `web/src/app/(user)/aesthetic-mirror/page.tsx`, keep action buttons `opacity-0` and reveal them with `group-hover:opacity-100`. Avoid persistent instruction overlays on uploaded images.

### Metadata
- Source: user_feedback
- Related Files: `web/src/app/(user)/aesthetic-mirror/page.tsx`
- Tags: upload-preview, hover-actions, ui-consistency

### Resolution
- **Resolved**: 2026-06-26T16:25:00+08:00
- **Notes**: Reference image preview now shows only the image by default; hover reveals high-contrast preview and remove buttons. Product thumbnail remove button also follows hover reveal behavior.

---
