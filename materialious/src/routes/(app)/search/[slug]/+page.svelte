<script lang="ts">
	import { getSearch } from '$lib/api';
	import ChannelThumbnail from '$lib/components/ChannelThumbnail.svelte';
	import ContentColumn from '$lib/components/ContentColumn.svelte';
	import HashtagThumbnail from '$lib/components/HashtagThumbnail.svelte';
	import PageLoading from '$lib/components/PageLoading.svelte';
	import PlaylistThumbnail from '$lib/components/PlaylistThumbnail.svelte';
	import Thumbnail from '$lib/components/Thumbnail.svelte';
	import { _ } from 'svelte-i18n';
	import InfiniteLoading, { type InfiniteEvent } from 'svelte-infinite-loading';

	let { data } = $props();

	let searchResults = $state(data);

	let currentPage = 1;

	async function changeType(type: 'playlist' | 'all' | 'video' | 'channel') {
		searchResults.searchType = type;
		currentPage = 1;
		searchResults.search = [];
		searchResults.search = await getSearch(searchResults.slug, { type: type });
	}

	async function loadMore(event: InfiniteEvent) {
		currentPage++;
		const newSearch = await getSearch(searchResults.slug, {
			page: currentPage.toString(),
			type: searchResults.searchType
		});

		if (newSearch.length === 0) {
			event.detail.complete();
		} else {
			searchResults.search = [...searchResults.search, ...newSearch];
			event.detail.loaded();
		}
	}
</script>

<div style="margin-top: 1em;">
	<div class="tabs left-align min scroll">
		<a
			class:active={searchResults.searchType === 'all'}
			href="#all"
			onclick={async () => changeType('all')}
		>
			<i>home</i>
			<span>{$_('videoTabs.all')}</span>
		</a>
		<a
			class:active={searchResults.searchType === 'video'}
			href="#videos"
			onclick={async () => changeType('video')}
		>
			<i>movie</i>
			<span>{$_('videoTabs.videos')}</span>
		</a>
		<a
			class:active={searchResults.searchType === 'playlist'}
			href="#playlists"
			onclick={async () => changeType('playlist')}
		>
			<i>playlist_add_check</i>
			<span>{$_('videoTabs.playlists')}</span>
		</a>
		<a
			class:active={searchResults.searchType === 'channel'}
			href="#channels"
			onclick={async () => changeType('channel')}
		>
			<i>person</i>
			<span>{$_('videoTabs.channels')}</span>
		</a>
	</div>
</div>

{#if searchResults.search.length > 0}
	<div class="page right active">
		<div class="space"></div>
		<div class="grid">
			{#each searchResults.search as item}
				<ContentColumn>
					{#key item}
						<article class="no-padding" style="height: 100%;">
							{#if item.type === 'video'}
								<Thumbnail video={item} />
							{:else if item.type === 'channel'}
								<ChannelThumbnail channel={item} />
							{:else if item.type === 'playlist'}
								<PlaylistThumbnail playlist={item} />
							{:else if item.type === 'hashtag'}
								<HashtagThumbnail hashtag={item} />
							{/if}
						</article>
					{/key}
				</ContentColumn>
			{/each}
		</div>
	</div>
{:else}
	<PageLoading />
{/if}

<InfiniteLoading on:infinite={loadMore} />
