import { getFeed } from '$lib/api/index';
import { feedCacheStore } from '$lib/store';
import { error } from '@sveltejs/kit';
import { get } from 'svelte/store';

export async function load() {
	let videos = get(feedCacheStore).subscription;

	if (!videos) {
		let feeds;
		try {
			feeds = await getFeed(100, 1);
		} catch (errorMessage: any) {
			error(500, errorMessage);
		}

		videos = [...feeds.notifications, ...feeds.videos];

		feedCacheStore.set({ subscription: videos });
	} else {
		await getFeed(100, 1).then((feeds) => {
			const newVideos = [...feeds.notifications, ...feeds.videos, ...videos];
			feedCacheStore.set({
				subscription: [...new Set(newVideos)]
			});
		});
	}
}
