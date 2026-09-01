<div class="review-app" aria-hidden="true">
	<div class="review-chrome">
		<div class="review-lights"><i></i><i></i><i></i></div>
		<nav><b>Guide</b><span>Diff</span><span>Activity</span></nav>
		<strong>#184 · Typed errors for user API</strong>
		<div class="review-actions"><span class="checks">✓ 4 checks⌄</span><span>▢ Chat</span><span>•••</span></div>
	</div>

	<div class="review-body">
		<aside class="review-why">
			<span class="review-count">01 / 03</span>
			<h3>Token rotation safety</h3>
			<p>Ensure refresh tokens are rotated atomically and old tokens cannot be used again.</p>
			<p class="review-muted">This prevents replay attacks if a token is stolen.</p>
			<div class="review-files-label">Files to review</div>
			<div class="review-file-chip"><span>auth/middleware.ts</span><b>+12</b><em>−4</em></div>
			<div class="review-file-chip"><span>auth/tokens.ts</span><b>+8</b><em>−2</em></div>
		</aside>

		<div class="review-diffs">
			<section class="review-diff-card">
				<header><strong>auth/middleware.ts</strong><span><b>+12</b> <em>−4</em></span></header>
				<div class="review-code">
					<div><i>48</i><code>const token = req.cookies.refreshToken;</code></div>
					<div class="del"><i>49</i><code>− if (!token) return res.sendStatus(401);</code></div>
					<div class="add"><i>50</i><code>+ if (!token) return res.sendStatus(401);</code></div>
					<div><i>51</i><code></code></div>
					<div class="add"><i>52</i><code>+ const rotated = await rotateToken(token);</code></div>
					<div class="add"><i>53</i><code>+ if (!rotated.valid) &#123;</code></div>
					<div class="add"><i>54</i><code>+ &nbsp; return res.sendStatus(401);</code></div>
					<div class="add"><i>55</i><code>+ &#125;</code></div>
				</div>
				<div class="review-comment">
					<span class="review-avatar">AK</span>
					<div><strong>Alex Kim <small>1m ago</small></strong><p>Nice—does rotateToken invalidate the old token atomically?</p><span>Reply</span></div>
				</div>
			</section>

			<section class="review-diff-card secondary">
				<header><strong>auth/tokens.ts</strong><span><b>+8</b> <em>−2</em></span></header>
				<div class="review-code">
					<div class="del"><i>32</i><code>− export async function rotateToken(token: string) &#123;</code></div>
					<div class="add"><i>32</i><code>+ export async function rotateToken(token: string) &#123;</code></div>
					<div><i>34</i><code>&nbsp; // invalidate previous token</code></div>
					<div class="add"><i>35</i><code>+ await db.refreshTokens.update(&#123;</code></div>
				</div>
			</section>
		</div>
	</div>

	<div class="review-tray">
		<span>▢ 1 comment⌄</span>
		<p>Overall, looks good. Address the comment and I’ll review again.</p>
		<strong>➤ Send to agent <i>⌄</i></strong>
	</div>
</div>

<style>
	.review-app {
		container-type: inline-size;
		display: flex;
		height: 100%;
		flex-direction: column;
		overflow: hidden;
		border-radius: inherit;
		background: rgba(250, 249, 246, 0.99);
		color: #3c3929;
		font-family: var(--font-sans);
	}
	.review-chrome {
		display: flex;
		height: 42px;
		flex-shrink: 0;
		align-items: center;
		gap: 11px;
		border-bottom: 1px solid rgba(0,0,0,.07);
		padding: 0 10px;
		font-size: 8px;
	}
	.review-lights { display: flex; flex-shrink: 0; gap: 4px; }
	.review-lights i { width: 7px; height: 7px; border-radius: 999px; background: #d97757; }
	.review-lights i:nth-child(2) { background: #d4af6a; }
	.review-lights i:nth-child(3) { background: #72a36f; }
	.review-chrome nav { display: flex; align-self: stretch; align-items: center; gap: 14px; }
	.review-chrome nav > * { display: grid; height: 100%; place-items: center; }
	.review-chrome nav b { box-shadow: inset 0 -2px #d97757; color: #292622; }
	.review-chrome nav span { color: #71695f; }
	.review-chrome > strong { min-width: 0; flex: 1; overflow: hidden; text-align: center; text-overflow: ellipsis; white-space: nowrap; }
	.review-actions { display: flex; flex-shrink: 0; align-items: center; gap: 5px; }
	.review-actions span { border-radius: 6px; padding: 5px 7px; box-shadow: 0 0 0 1px rgba(0,0,0,.07); white-space: nowrap; }
	.review-actions .checks { background: rgba(74,124,92,.09); color: #4a7c5c; box-shadow: 0 0 0 1px rgba(74,124,92,.12); }
	.review-body { display: grid; min-height: 0; flex: 1; grid-template-columns: minmax(138px, .7fr) minmax(0, 1.7fr); gap: 10px; padding: 10px; }
	.review-why { min-width: 0; border-radius: 9px; padding: 9px 10px; box-shadow: 0 0 0 1px rgba(0,0,0,.07); }
	.review-count { color: #a69b90; font-family: var(--font-mono); font-size: 7.5px; font-variant-numeric: tabular-nums; }
	.review-why h3 { margin: 8px 0 7px; font-family: var(--font-display); font-size: 11px; font-weight: 600; letter-spacing: -.015em; }
	.review-why p { margin: 0; color: #655e55; font-size: 8px; line-height: 1.55; }
	.review-why .review-muted { margin-top: 8px; color: #8f857b; }
	.review-files-label { margin-top: 16px; color: #6d655d; font-size: 7.5px; font-weight: 600; }
	.review-file-chip { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: 4px; margin-top: 6px; border-radius: 6px; padding: 6px 7px; box-shadow: 0 0 0 1px rgba(0,0,0,.07); font-family: var(--font-mono); font-size: 6.8px; }
	.review-file-chip span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.review-file-chip b, .review-diff-card header b { color: #4a7c5c; font-weight: 500; }
	.review-file-chip em, .review-diff-card header em { color: #b06a5a; font-style: normal; }
	.review-diffs { display: flex; min-width: 0; flex-direction: column; gap: 9px; }
	.review-diff-card { position: relative; min-width: 0; flex: 1; border-radius: 9px; background: white; box-shadow: 0 0 0 1px rgba(0,0,0,.07), 0 7px 16px rgba(70,55,35,.04); }
	.review-diff-card.secondary { flex: .54; }
	.review-diff-card header { display: flex; align-items: center; justify-content: space-between; gap: 8px; border-bottom: 1px solid rgba(0,0,0,.06); padding: 7px 9px; font-family: var(--font-mono); font-size: 7.5px; }
	.review-diff-card header span { display: flex; gap: 7px; font-variant-numeric: tabular-nums; }
	.review-code { overflow: hidden; padding: 4px 0; }
	.review-code > div { display: grid; grid-template-columns: 26px minmax(0,1fr); min-height: 15px; align-items: center; font-size: 6.7px; }
	.review-code i { align-self: stretch; border-right: 1px solid rgba(0,0,0,.05); padding: 3px 6px 2px 0; color: #aaa096; text-align: right; font-family: var(--font-mono); font-style: normal; font-variant-numeric: tabular-nums; }
	.review-code code { overflow: hidden; padding: 2px 7px; color: #655e55; font-family: var(--font-mono); text-overflow: ellipsis; white-space: nowrap; }
	.review-code .add { background: rgba(74,124,92,.09); }
	.review-code .add code { color: #4a7c5c; }
	.review-code .del { background: rgba(176,106,90,.09); }
	.review-code .del code { color: #b06a5a; }
	.review-comment {
		position: absolute;
		right: 12px;
		bottom: -24px;
		z-index: 2;
		display: flex;
		width: min(72%, 240px);
		gap: 7px;
		border-radius: 9px;
		background: #fff;
		padding: 8px;
		box-shadow: 0 0 0 1px rgba(0,0,0,.09), 0 10px 25px rgba(70,55,35,.14);
	}
	.review-avatar { display: grid; width: 19px; height: 19px; flex-shrink: 0; place-items: center; border-radius: 999px; box-shadow: 0 0 0 1px rgba(0,0,0,.12); font-size: 6.5px; }
	.review-comment > div { min-width: 0; }
	.review-comment strong { display: flex; align-items: baseline; gap: 5px; font-size: 7px; }
	.review-comment small { color: #9a9086; font-size: 6px; font-weight: 400; }
	.review-comment p { margin: 4px 0; font-size: 6.8px; line-height: 1.35; }
	.review-comment > div > span { border-radius: 4px; background: #f5f2ed; padding: 2px 4px; color: #8f857b; font-size: 6px; }
	.review-tray { display: grid; flex-shrink: 0; grid-template-columns: auto minmax(0,1fr) auto; align-items: center; gap: 10px; border-top: 1px solid rgba(0,0,0,.07); padding: 7px 10px; }
	.review-tray > span { border-radius: 6px; padding: 6px 8px; box-shadow: 0 0 0 1px rgba(0,0,0,.08); font-size: 7px; }
	.review-tray p { margin: 0; color: #6d655d; font-size: 7px; line-height: 1.35; }
	.review-tray > strong { border-radius: 7px; background: #d97757; padding: 7px 7px 7px 10px; color: white; font-size: 7.5px; font-weight: 600; box-shadow: 0 4px 12px rgba(217,119,87,.22); }
	.review-tray > strong i { margin-left: 7px; border-left: 1px solid rgba(255,255,255,.28); padding-left: 7px; font-style: normal; }

	@container (max-width: 520px) {
		.review-actions span:not(.checks), .review-chrome nav span:last-child { display: none; }
		.review-body { grid-template-columns: minmax(110px, .65fr) minmax(0, 1.6fr); }
		.review-why .review-muted, .review-file-chip:nth-child(7) { display: none; }
	}
	@container (max-width: 390px) {
		.review-chrome > strong { display: none; }
		.review-body { grid-template-columns: 1fr; }
		.review-why { display: none; }
		.review-comment { bottom: 8px; }
	}
</style>
