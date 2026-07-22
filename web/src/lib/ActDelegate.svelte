<div class="delegate-app" aria-hidden="true">
	<div class="delegate-chrome">
		<div class="delegate-lights"><i></i><i></i><i></i></div>
		<div class="delegate-tabs">
			<div class="delegate-tab active"><i></i>auth-refactor</div>
			<div class="delegate-tab"><i></i>session-hardening</div>
			<div class="delegate-tab"><i></i>csrf-protection</div>
		</div>
		<div class="delegate-new">＋ <span>New session</span></div>
	</div>

	<div class="delegate-body">
		<div class="delegate-conversation">
			<div class="delegate-context">
				<div>
					<strong>auth-refactor</strong>
					<span>⌁ feature/auth-refactor</span>
				</div>
				<span class="delegate-running"><i></i> Working</span>
			</div>

			<div class="delegate-message user">
				<span class="delegate-avatar">AK</span>
				<p>Refactor authentication to use HttpOnly cookies and rotate refresh tokens.</p>
			</div>
			<div class="delegate-message agent">
				<span class="delegate-avatar">S</span>
				<div>
					<div class="delegate-agent-name">Solus <span>Working</span></div>
					<p>I’ll update the refresh-token flow, follow the existing security patterns, and validate the change.</p>
				</div>
			</div>

			<div class="delegate-progress">
				<div class="done"><i>✓</i><strong>Plan and scope</strong><span>Completed</span></div>
				<div class="active"><i></i><strong>Implement changes</strong><span>In progress</span></div>
				<div class="step"><i></i><span>Update auth middleware</span><b>1 / 4</b></div>
				<div class="step"><i></i><span>Add refresh-token rotation</span><b>2 / 3</b></div>
				<div class="step"><i></i><span>Update tests</span><b>Pending</b></div>
			</div>

			<div class="delegate-input">
				<span>Plan, Build, Automate / @ for context</span>
				<div><b>@</b><b>⌕</b><em>Solus 3.5⌄</em><i>↑</i></div>
			</div>
		</div>

		<aside class="delegate-project">
			<section>
				<h4>Git</h4>
				<div class="delegate-branch">⌁ feature/auth-refactor <span>⌄</span></div>
				<dl>
					<div><dt>Uncommitted</dt><dd>4</dd></div>
					<div><dt>Staged</dt><dd>6</dd></div>
					<div><dt>Ahead of main</dt><dd>2</dd></div>
				</dl>
			</section>
			<section class="delegate-tasks">
				<h4>Tasks <span>＋</span></h4>
				<div><i class="green"></i>Refactor auth middleware</div>
				<div><i></i>Add refresh-token rotation</div>
				<div><i></i>Update tests</div>
				<div><i class="muted"></i>Update docs</div>
			</section>
			<span class="delegate-view">View branch ↗</span>
		</aside>
	</div>
</div>

<style>
	.delegate-app {
		container-type: inline-size;
		display: flex;
		height: 100%;
		flex-direction: column;
		overflow: hidden;
		border-radius: inherit;
		background: rgba(250, 249, 246, 0.98);
		color: #3c3929;
		font-family: var(--font-sans);
	}
	.delegate-chrome {
		display: flex;
		height: 40px;
		flex-shrink: 0;
		align-items: center;
		gap: 10px;
		border-bottom: 1px solid rgba(0, 0, 0, 0.07);
		padding: 0 10px;
	}
	.delegate-lights { display: flex; flex-shrink: 0; gap: 4px; }
	.delegate-lights i { width: 7px; height: 7px; border-radius: 999px; background: #d97757; }
	.delegate-lights i:nth-child(2) { background: #d4af6a; }
	.delegate-lights i:nth-child(3) { background: #72a36f; }
	.delegate-tabs { display: flex; min-width: 0; flex: 1; align-self: stretch; }
	.delegate-tab {
		display: flex;
		min-width: 0;
		flex: 1;
		align-items: center;
		justify-content: center;
		gap: 6px;
		border-left: 1px solid rgba(0, 0, 0, 0.05);
		color: #8b8177;
		font-size: 9px;
		white-space: nowrap;
	}
	.delegate-tab i { width: 6px; height: 6px; flex-shrink: 0; border-radius: 999px; background: #d4af6a; }
	.delegate-tab.active { box-shadow: inset 0 -2px #d97757; color: #292622; font-weight: 600; }
	.delegate-tab.active i { background: #d97757; }
	.delegate-new {
		display: flex;
		flex-shrink: 0;
		align-items: center;
		gap: 5px;
		border-radius: 7px;
		padding: 5px 8px;
		box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.07);
		color: #5f584f;
		font-size: 9px;
	}
	.delegate-body { display: grid; min-height: 0; flex: 1; grid-template-columns: minmax(0, 2fr) minmax(122px, 0.82fr); }
	.delegate-conversation { display: flex; min-width: 0; flex-direction: column; padding: 13px 14px 10px; }
	.delegate-context { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
	.delegate-context div { display: flex; min-width: 0; flex-direction: column; gap: 2px; }
	.delegate-context strong { font-size: 11px; }
	.delegate-context span { color: #9b9084; font-family: var(--font-mono); font-size: 8px; }
	.delegate-running { display: flex; flex-shrink: 0; align-items: center; gap: 5px; color: #c56443 !important; }
	.delegate-running i { width: 6px; height: 6px; border-radius: 999px; background: #d97757; }
	.delegate-message { display: flex; align-items: flex-start; gap: 8px; }
	.delegate-message.user { margin-top: 14px; }
	.delegate-message.agent { margin-top: 12px; }
	.delegate-avatar {
		display: grid;
		width: 21px;
		height: 21px;
		flex-shrink: 0;
		place-items: center;
		border-radius: 999px;
		box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.13);
		font-size: 7px;
		font-weight: 600;
	}
	.delegate-message p { margin: 0; font-size: 9px; line-height: 1.55; }
	.delegate-message.user p { border-radius: 9px; background: #fff; padding: 8px 10px; box-shadow: 0 0 0 1px rgba(0,0,0,.07), 0 5px 12px rgba(70,55,35,.05); }
	.delegate-message.agent > div { min-width: 0; }
	.delegate-agent-name { margin-bottom: 5px; font-size: 9px; font-weight: 600; }
	.delegate-agent-name span { margin-left: 4px; color: #d97757; font-size: 8px; font-weight: 500; }
	.delegate-progress { display: flex; flex-direction: column; gap: 7px; margin: 14px 2px 10px 30px; }
	.delegate-progress > div { display: grid; grid-template-columns: 12px minmax(0, 1fr) auto; align-items: center; gap: 6px; font-size: 8.5px; }
	.delegate-progress i { display: grid; width: 9px; height: 9px; place-items: center; border: 1px solid #a99f94; border-radius: 999px; font-size: 6px; font-style: normal; }
	.delegate-progress .done i { border: 0; background: #4a7c5c; color: white; }
	.delegate-progress .active i { border: 0; background: #d97757; }
	.delegate-progress .step { padding-left: 12px; color: #665f56; }
	.delegate-progress .step b { color: #9b9084; font-weight: 400; }
	.delegate-progress > div > span:last-child { color: #9b9084; }
	.delegate-input {
		margin-top: auto;
		border-radius: 16px;
		background: rgba(255, 255, 255, 0.99);
		padding: 10px 11px 9px;
		border: 1px solid #d2cfc5;
		box-shadow: 0 8px 20px rgba(70,55,35,.06);
		color: #aaa096;
		font-size: 8.5px;
	}
	.delegate-input > div { display: flex; align-items: center; gap: 8px; margin-top: 9px; }
	.delegate-input b { color: #766f67; font-family: var(--font-mono); font-size: 9px; }
	.delegate-input em { margin-left: auto; color: #8b8177; font-family: var(--font-mono); font-size: 7px; font-style: normal; }
	.delegate-input i { display: grid; width: 22px; height: 22px; place-items: center; border-radius: 999px; background: linear-gradient(145deg, #e08868 0%, #d97757 40%, #c96442 100%); color: white; font-size: 12px; font-weight: 700; font-style: normal; box-shadow: 0 2px 8px rgba(217,119,87,.2), 0 1px 2px rgba(0,0,0,.2); }
	.delegate-project { display: flex; min-width: 0; flex-direction: column; border-left: 1px solid rgba(0, 0, 0, 0.07); padding: 12px 10px 9px; }
	.delegate-project section + section { margin-top: 14px; border-top: 1px solid rgba(0,0,0,.06); padding-top: 12px; }
	.delegate-project h4 { display: flex; align-items: center; justify-content: space-between; margin: 0 0 8px; font-size: 9.5px; }
	.delegate-project h4 span { display: grid; width: 18px; height: 18px; place-items: center; border-radius: 5px; box-shadow: 0 0 0 1px rgba(0,0,0,.07); font-weight: 400; }
	.delegate-branch { display: flex; justify-content: space-between; gap: 5px; border-radius: 6px; background: #fff; padding: 6px; box-shadow: 0 0 0 1px rgba(0,0,0,.07); font-family: var(--font-mono); font-size: 7px; }
	.delegate-project dl { display: flex; flex-direction: column; gap: 5px; margin: 9px 1px 0; }
	.delegate-project dl div { display: flex; justify-content: space-between; gap: 5px; font-size: 7.5px; }
	.delegate-project dd { margin: 0; font-variant-numeric: tabular-nums; }
	.delegate-tasks > div { display: flex; align-items: center; gap: 6px; border-radius: 6px; padding: 6px; font-size: 7.5px; }
	.delegate-tasks > div + div { margin-top: 3px; background: rgba(255,255,255,.55); box-shadow: 0 0 0 1px rgba(0,0,0,.04); }
	.delegate-tasks i { width: 6px; height: 6px; flex-shrink: 0; border-radius: 999px; background: #d97757; }
	.delegate-tasks i.green { background: #4a7c5c; }
	.delegate-tasks i.muted { background: #bbb3aa; }
	.delegate-view { margin-top: auto; color: #766f67; font-size: 7.5px; }

	@container (max-width: 440px) {
		.delegate-project { display: none; }
		.delegate-body { grid-template-columns: 1fr; }
		.delegate-tab:nth-child(3) { display: none; }
		.delegate-new span { display: none; }
	}
</style>
