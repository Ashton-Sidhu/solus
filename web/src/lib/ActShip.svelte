<div class="ship-app" aria-hidden="true">
	<div class="ship-chrome">
		<div class="ship-lights"><i></i><i></i><i></i></div>
		<span>↻</span><span>•••</span>
	</div>
	<div class="ship-content">
		<header><strong>Pull request #284</strong><span>ready</span></header>
		<div class="ship-progress">
			<div class="ship-line"><i class="done"></i><b></b><b></b><i class="done"></i></div>
			<div class="ship-row passed">
				<i>✓</i><div><strong>Required checks</strong><span>all checks passed</span></div><b>›</b>
			</div>
			<div class="ship-row passed">
				<i>✓</i><div><strong>Review</strong><span>approved</span></div><b>›</b>
			</div>
			<div class="ship-row merged">
				<i>✓</i><div><strong>Squash and merge</strong><span>merged</span></div><b>⌁</b>
			</div>
		</div>
		<span class="ship-view">View pull request　›</span>
	</div>
</div>

<style>
	.ship-app {
		display: flex;
		height: 100%;
		flex-direction: column;
		overflow: hidden;
		border-radius: inherit;
		background: rgba(250, 249, 246, 0.99);
		color: #3c3929;
		font-family: var(--font-sans);
	}
	.ship-chrome { display: flex; height: 39px; flex-shrink: 0; align-items: center; gap: 10px; border-bottom: 1px solid rgba(0,0,0,.07); padding: 0 11px; color: #8f857b; font-size: 9px; }
	.ship-lights { display: flex; flex: 1; gap: 4px; }
	.ship-lights i { width: 7px; height: 7px; border-radius: 999px; background: #d97757; }
	.ship-lights i:nth-child(2) { background: #d4af6a; }
	.ship-lights i:nth-child(3) { background: #72a36f; }
	.ship-content { display: flex; min-height: 0; flex: 1; flex-direction: column; padding: 13px 12px 10px; }
	.ship-content > header { display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid rgba(0,0,0,.06); padding: 0 2px 10px; }
	.ship-content > header strong { font-family: var(--font-display); font-size: 11px; }
	.ship-content > header span { color: #9c9288; font-family: var(--font-mono); font-size: 7px; }
	.ship-progress { position: relative; display: flex; flex: 1; flex-direction: column; justify-content: center; gap: 7px; padding: 8px 0; }
	.ship-line { position: absolute; top: 18%; bottom: 17%; left: 14px; width: 1px; background: linear-gradient(#d4af6a 0 27%, #4a7c5c 27% 100%); }
	.ship-line i, .ship-line b { position: absolute; left: 50%; width: 8px; height: 8px; transform: translateX(-50%); border: 1px solid #d4af6a; border-radius: 999px; background: #faf9f6; }
	.ship-line i { top: 0; }
	.ship-line b:nth-child(2) { top: 31%; border-color: #4a7c5c; background: #4a7c5c; }
	.ship-line b:nth-child(3) { top: 62%; border-color: #4a7c5c; background: #4a7c5c; }
	.ship-line i.done { top: 100%; border-color: #4a7c5c; background: #4a7c5c; }
	.ship-row { position: relative; z-index: 1; display: flex; min-height: 45px; align-items: center; gap: 8px; border-radius: 8px; background: rgba(255,255,255,.72); padding: 7px 9px 7px 25px; box-shadow: 0 0 0 1px rgba(0,0,0,.06), 0 5px 12px rgba(70,55,35,.05); }
	.ship-row > div { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 3px; }
	.ship-row strong { overflow: hidden; font-family: var(--font-mono); font-size: 8.5px; text-overflow: ellipsis; white-space: nowrap; }
	.ship-row span { color: #958b81; font-size: 8px; }
	.ship-row > b { color: #8f857b; font-size: 11px; font-weight: 400; }
	.ship-row > i { position: absolute; left: 8px; display: grid; width: 13px; height: 13px; place-items: center; border-radius: 999px; background: #4a7c5c; color: white; font-size: 7px; font-style: normal; }
	.ship-row.passed span, .ship-row.merged span { color: #4a7c5c; }
	.ship-row.merged { background: white; }
	.ship-row.merged > i { width: 17px; height: 17px; left: 6px; }
	.ship-view { color: #766f67; font-size: 7.5px; }
</style>
