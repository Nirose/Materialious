<script lang="ts">
	import VideoList from '$lib/VideoList.svelte';
	import { activePageStore } from '$lib/store';

	export let data;

	activePageStore.set('home');
</script>

{#if data.popularDisabled}
	<div class="space"></div>

	<nav class="center-align">
		<p>Popular page has been disabled</p>
	</nav>
{:else}
	<VideoList videos={data.popular} />
{/if}
