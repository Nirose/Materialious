<script lang="ts">
	import { page } from '$app/stores';
	import '$lib/css/shaka-player-theme.css';
	import { getBestThumbnail } from '$lib/images';
	import { padTime, videoLength } from '$lib/numbers';
	import { type PhasedDescription } from '$lib/timestamps';
	import { Capacitor } from '@capacitor/core';
	import { ScreenOrientation, type ScreenOrientationResult } from '@capacitor/screen-orientation';
	import { StatusBar, Style } from '@capacitor/status-bar';
	import { NavigationBar } from '@hugotomazi/capacitor-navigation-bar';
	import { type Page } from '@sveltejs/kit';
	import { base64ToU8, Protos } from 'googlevideo';
	import ui from 'beercss';
	import ISO6391 from 'iso-639-1';
	import Mousetrap from 'mousetrap';
	import 'shaka-player/dist/controls.css';
	import shaka from 'shaka-player/dist/shaka-player.ui';
	import { SponsorBlock, type Category, type Segment } from 'sponsorblock-api';
	import { onDestroy, onMount } from 'svelte';
	import { _ } from 'svelte-i18n';
	import { get } from 'svelte/store';
	import { deleteVideoProgress, getVideoProgress, saveVideoProgress } from '../api';
	import type { VideoPlay } from '../api/model';
	import {
		authStore,
		companionStore,
		instanceStore,
		playerAndroidLockOrientation,
		playerAutoPlayStore,
		playerDefaultLanguage,
		playerDefaultQualityStore,
		playerProxyVideosStore,
		playerSavePlaybackPositionStore,
		poTokenCacheStore,
		sponsorBlockCategoriesStore,
		sponsorBlockDisplayToastStore,
		sponsorBlockStore,
		sponsorBlockUrlStore,
		synciousInstanceStore,
		synciousStore
	} from '../store';
	import { getDynamicTheme, setStatusBarColor } from '../theme';
	import { HttpFetchPlugin, type SabrStreamingContext } from '$lib/sabr/shakaHttpPlugin';
	import { Constants, type Misc } from 'youtubei.js';
	import {
		fromFormat,
		fromFormatInitializationMetadata,
		fromMediaHeader,
		getUniqueFormatId
	} from '$lib/sabr/formatKeyUtils';

	interface Props {
		data: { video: VideoPlay; content: PhasedDescription; playlistId: string | null };
		isSyncing?: boolean;
		isEmbed?: boolean;
		segments?: Segment[];
		playerElement: HTMLMediaElement | undefined;
	}

	let {
		data,
		isEmbed = false,
		segments = $bindable([]),
		playerElement = $bindable()
	}: Props = $props();

	let snackBarAlert = $state('');
	let playerPosSet = false;
	let originalOrigination: ScreenOrientationResult | undefined;
	let watchProgressTimeout: NodeJS.Timeout;
	let userWantsFullscreen = false;

	let player: shaka.Player;
	let shakaUi: shaka.ui.Overlay;

	// Shaka player required variables for SABR based off LuanRT's example
	const sessionId = Array.from(Array(16), () => Math.floor(Math.random() * 36).toString(36)).join(
		''
	);
	let videoPlaybackUstreamerConfig: string | undefined;
	let serverAbrStreamingUrl: URL | undefined = undefined;
	let drmParams: string | undefined;
	let lastRequestMs = 0;
	let lastSeekMs = 0;
	let lastManualFormatSelectionMs = 0;
	let lastActionMs = 0;
	let playerElementResizeObserver: ResizeObserver | undefined;
	let clientViewportHeight = playerElement?.clientHeight || 0;
	let clientViewportWidth = playerElement?.clientWidth || 0;
	let lastPlaybackCookie: Protos.PlaybackCookie | undefined;
	const initializedFormats = new Map<
		string,
		{
			lastSegmentMetadata?: {
				formatId: Protos.FormatId;
				startTimeMs: number;
				startSequenceNumber: number;
				endSequenceNumber: number;
				durationMs: number;
			};
			formatInitializationMetadata: Protos.FormatInitializationMetadata;
		}
	>();
	let formatList: Misc.Format[] = [];

	shaka.net.NetworkingEngine.registerScheme(
		'http',
		HttpFetchPlugin.parse,
		shaka.net.NetworkingEngine.PluginPriority.PREFERRED
	);
	shaka.net.NetworkingEngine.registerScheme(
		'https',
		HttpFetchPlugin.parse,
		shaka.net.NetworkingEngine.PluginPriority.PREFERRED
	);
	// Shaka player SABR var end

	const STORAGE_KEY_VOLUME = 'shaka-preferred-volume';

	function saveVolumePreference() {
		if (!playerElement) return;
		localStorage.setItem(STORAGE_KEY_VOLUME, playerElement.volume.toString());
	}

	function restoreQualityPreference() {
		const numericValue = parseInt($playerDefaultQualityStore, 10);

		if (isNaN(numericValue)) {
			player.configure({ abr: { enabled: true } });
			return;
		}

		// Get video-only variant tracks
		const tracks = player.getVariantTracks().filter((t) => t.height !== null);

		// Sort by resolution descending
		const sortedTracks = tracks.sort((a, b) => (b.height as number) - (a.height as number));

		// Try exact match
		let selectedTrack = sortedTracks.find((t) => t.height === numericValue);

		// Try next best (lower than target)
		if (!selectedTrack) {
			selectedTrack = sortedTracks.find((t) => (t.height as number) < numericValue);
		}

		// Try next higher
		if (!selectedTrack) {
			selectedTrack = sortedTracks.find((t) => (t.height as number) > numericValue);
		}

		if (selectedTrack) {
			player.selectVariantTrack(selectedTrack, true);
			HttpFetchPlugin.cacheManager.clearCache();
			player.configure({ abr: { enabled: false } });
		} else {
			player.configure({ abr: { enabled: true } });
		}
	}

	function loadTimeFromUrl(page: Page): boolean {
		if (player) {
			const timeGivenUrl = page.url.searchParams.get('time');
			if (timeGivenUrl && !isNaN(parseFloat(timeGivenUrl))) {
				if (!playerElement) return false;
				playerElement.currentTime = Number(timeGivenUrl);
				return true;
			}
		}

		return false;
	}

	page.subscribe((pageUpdate) => loadTimeFromUrl(pageUpdate));

	const proxyVideos = get(playerProxyVideosStore);

	onMount(async () => {
		shaka.polyfill.installAll();
		if (!shaka.Player.isBrowserSupported()) {
			return;
		}

		HttpFetchPlugin.cacheManager.clearCache();

		player = new shaka.Player();
		player.configure({
			abr: {
				enabled: true,
				restrictions: {
					maxWidth: 1920,
					maxHeight: 1080
				}
			},
			streaming: {
				bufferingGoal: 120,
				rebufferingGoal: 0.01,
				bufferBehind: 300,
				retryParameters: {
					maxAttempts: 30,
					baseDelay: 1500,
					backoffFactor: 2.5,
					fuzzFactor: 0.7,
					timeout: 120000
				},
				stallThreshold: 2,
				stallSkip: 0.5
			}
		});
		playerElement = document.getElementById('player') as HTMLMediaElement;

		playerElementResizeObserver = new ResizeObserver(() => {
			if (playerElement) {
				clientViewportHeight = playerElement.clientHeight;
				clientViewportWidth = playerElement.clientWidth;
			}
		});

		playerElementResizeObserver.observe(playerElement);

		// Change instantly to stop video from being loud for a second
		const savedVolume = localStorage.getItem(STORAGE_KEY_VOLUME);
		if (savedVolume) {
			playerElement.volume = parseFloat(savedVolume);
		}

		shakaUi = new shaka.ui.Overlay(
			player,
			document.getElementById('shaka-container') as HTMLElement,
			playerElement
		);

		shakaUi.configure({
			controlPanelElements: [
				'play_pause',
				Capacitor.getPlatform() === 'android' ? '' : 'volume',
				'spacer',
				'chapter',
				'time_and_duration',
				'captions',
				'overflow_menu',
				'fullscreen'
			],
			overflowMenuButtons: [
				'cast',
				'airplay',
				'captions',
				'quality',
				'playback_rate',
				'loop',
				'language',
				'statistics'
			],
			playbackRates: [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3],
			enableTooltips: false,
			seekBarColors: {
				played: (await getDynamicTheme())['--primary']
			}
		});

		if (data.video.fallbackPatch === 'youtubejs' && data.video.ytjs) {
			if (
				data.video.ytjs.rawApiResponse.data.streamingData &&
				(data.video.ytjs.rawApiResponse.data.streamingData as any).drmParams
			) {
				drmParams = (data.video.ytjs.rawApiResponse.data.streamingData as any).drmParams;
				player.configure({
					drm: {
						servers: {
							'com.widevine.alpha':
								'https://www.youtube.com/youtubei/v1/player/get_drm_license?alt=json'
						}
					}
				});
			}

			videoPlaybackUstreamerConfig =
				data.video.ytjs.video.page[0].player_config?.media_common_config
					.media_ustreamer_request_config?.video_playback_ustreamer_config;

			if (data.video.ytjs.video.streaming_data) {
				formatList = data.video.ytjs.video.streaming_data.adaptive_formats;
			}

			if (data.video.ytjs.video.streaming_data?.server_abr_streaming_url)
				serverAbrStreamingUrl = new URL(
					data.video.ytjs.innertube.session.player!.decipher(
						data.video.ytjs.video.streaming_data.server_abr_streaming_url
					)
				);

			playerElement.addEventListener('seeked', () => (lastSeekMs = Date.now()));

			player.addEventListener('variantchanged', (event) => {
				// Technically, all variant changes here are manual, given we don't handle ABR updates from the server.
				if (event.type !== 'variant') {
					lastManualFormatSelectionMs = Date.now();
				}

				lastActionMs = Date.now();
			});

			player.addEventListener('error', (event) => {
				const error = (event as CustomEvent).detail as shaka.util.Error;
				console.error('Player error:', error);
			});

			const networkingEngine = player.getNetworkingEngine();

			if (!networkingEngine) return;

			// Required to stop buttons from being still selected when fullscreening
			document.addEventListener('fullscreenchange', async () => {
				userWantsFullscreen = document.fullscreenElement !== null;
				const buttons = document.querySelectorAll('.shaka-controls-button-panel button');
				buttons.forEach((button) => {
					// Reset the button's focus and active states
					(button as HTMLElement).blur(); // Remove focus from the button
					button.removeAttribute('aria-pressed'); // Reset any ARIA attributes that might indicate selection
				});

				const tempDiv = document.createElement('div');
				tempDiv.click();
				document.removeChild(tempDiv);
			});

			// Based off the following
			// https://github.com/FreeTubeApp/FreeTube/blob/d270c9e251a433f1e4246a3f6a37acef707d22aa/src/renderer/components/ft-shaka-video-player/ft-shaka-video-player.js#L1206
			// https://github.com/LuanRT/BgUtils/blob/6b121166be1ccb0b952dee1bdac488808365ae6b/examples/browser/web/src/main.ts#L293
			// https://github.com/LuanRT/yt-sabr-shaka-demo/blob/main/src/components/VideoPlayer.vue
			networkingEngine.registerRequestFilter(async (type, request, context) => {
				if (!player) return;

				const originalUrl = new URL(request.uris[0]);
				let url = originalUrl.hostname === 'sabr' ? serverAbrStreamingUrl : originalUrl;
				const headers = request.headers;

				if (!url) return;

				if (
					type === shaka.net.NetworkingEngine.RequestType.SEGMENT &&
					url.pathname.includes('videoplayback')
				) {
					if (!data.video.liveNow) {
						const currentFormat = formatList.find(
							(format) =>
								fromFormat(format) === (new URL(request.uris[0]).searchParams.get('___key') || '')
						);

						if (!videoPlaybackUstreamerConfig) throw new Error('Ustreamer config not found.');

						if (!currentFormat) throw new Error('No format found for SABR request.');

						if (!playerElement) throw new Error('No video element found.');

						const activeVariant = player
							.getVariantTracks()
							.find(
								(track) =>
									getUniqueFormatId(currentFormat) ===
									(currentFormat.has_video ? track.originalVideoId : track.originalAudioId)
							);

						let videoFormat: Misc.Format | undefined;
						let audioFormat: Misc.Format | undefined;
						let videoFormatId: Protos.FormatId | undefined;
						let audioFormatId: Protos.FormatId | undefined;

						if (activeVariant) {
							for (const fmt of formatList) {
								const uniqueFormatId = getUniqueFormatId(fmt);
								if (uniqueFormatId === activeVariant.originalVideoId) {
									videoFormat = fmt;
								} else if (uniqueFormatId === activeVariant.originalAudioId) {
									audioFormat = fmt;
								}
							}
						}

						if (videoFormat) {
							videoFormatId = {
								itag: videoFormat.itag,
								lastModified: parseInt(videoFormat.last_modified_ms),
								xtags: videoFormat.xtags
							};
						}

						if (audioFormat) {
							audioFormatId = {
								itag: audioFormat.itag,
								lastModified: parseInt(audioFormat.last_modified_ms),
								xtags: audioFormat.xtags
							};
						}

						const isInit = context ? !context.segment : true;

						const videoPlaybackAbrRequest: Protos.VideoPlaybackAbrRequest = {
							clientAbrState: {
								playbackRate: player.getPlaybackRate(),
								playerTimeMs: Math.round(
									(context?.segment?.getStartTime() ?? playerElement.currentTime) * 1000
								),
								elapsedWallTimeMs: Date.now() - lastRequestMs,
								timeSinceLastSeek: lastSeekMs === 0 ? 0 : Date.now() - lastSeekMs,
								timeSinceLastActionMs: lastActionMs === 0 ? 0 : Date.now() - lastActionMs,
								timeSinceLastManualFormatSelectionMs:
									lastManualFormatSelectionMs === 0 ? 0 : Date.now() - lastManualFormatSelectionMs,
								clientViewportIsFlexible: false,
								bandwidthEstimate: Math.round(player.getStats().estimatedBandwidth),
								drcEnabled: currentFormat.is_drc === true,
								enabledTrackTypesBitfield: currentFormat.has_audio ? 1 : 2,
								clientViewportHeight,
								clientViewportWidth
							},
							bufferedRanges: [],
							selectedFormatIds: [],
							selectedAudioFormatIds: [audioFormatId || {}],
							selectedVideoFormatIds: [videoFormatId || {}],
							videoPlaybackUstreamerConfig: base64ToU8(videoPlaybackUstreamerConfig),
							streamerContext: {
								poToken: base64ToU8(get(poTokenCacheStore) ?? ''),
								playbackCookie: lastPlaybackCookie
									? Protos.PlaybackCookie.encode(lastPlaybackCookie).finish()
									: undefined,
								clientInfo: {
									clientName: parseInt(Constants.CLIENT_NAME_IDS.WEB),
									clientVersion: data.video.ytjs?.innertube.session.context.client.clientVersion,
									osName: 'Windows',
									osVersion: '10.0'
								},
								field5: [],
								field6: []
							},
							field1000: []
						};

						// Normalize the resolution.
						if (currentFormat.width && currentFormat.height) {
							let resolution = currentFormat.height;

							const aspectRatio = currentFormat.height / currentFormat.width;

							if (aspectRatio > 16 / 9) {
								resolution = Math.round((currentFormat.width * 9) / 16);
							}

							if (resolution && videoPlaybackAbrRequest.clientAbrState) {
								videoPlaybackAbrRequest.clientAbrState.stickyResolution = resolution;
								videoPlaybackAbrRequest.clientAbrState.lastManualSelectedResolution = resolution;
							}
						}

						if (!isInit) {
							// Add the currently/previously active formats to the list of buffered ranges and selected formats
							// so that the server doesn't send its init data again.
							const initializedFormatsArray = Array.from(initializedFormats.values());

							for (const initializedFormat of initializedFormatsArray) {
								if (initializedFormat.lastSegmentMetadata) {
									videoPlaybackAbrRequest.bufferedRanges.push({
										formatId: initializedFormat.lastSegmentMetadata.formatId,
										startSegmentIndex: initializedFormat.lastSegmentMetadata.startSequenceNumber,
										durationMs: initializedFormat.lastSegmentMetadata.durationMs,
										startTimeMs: 0,
										endSegmentIndex: initializedFormat.lastSegmentMetadata.endSequenceNumber
									});
								}
							}

							if (audioFormatId) videoPlaybackAbrRequest.selectedFormatIds.push(audioFormatId);

							if (videoFormatId) videoPlaybackAbrRequest.selectedFormatIds.push(videoFormatId);
						}

						request.body = Protos.VideoPlaybackAbrRequest.encode(videoPlaybackAbrRequest).finish();

						const byteRange = headers.Range
							? {
									start: Number(headers.Range.split('=')[1].split('-')[0]),
									end: Number(headers.Range.split('=')[1].split('-')[1])
								}
							: null;

						const sabrStreamingContext = {
							byteRange,
							format: currentFormat,
							isInit,
							isUMP: true,
							isSABR: true,
							playerTimeMs: videoPlaybackAbrRequest.clientAbrState?.playerTimeMs
						};

						// @NOTE: Not a real header. See the http plugin code for more info.
						request.headers['X-Streaming-Context'] = btoa(JSON.stringify(sabrStreamingContext));
						delete headers.Range;
					} else {
						url.pathname += `/ump/1/srfvp/1/pot/${get(poTokenCacheStore)}`;

						request.headers['X-Streaming-Context'] = btoa(
							JSON.stringify({
								isUMP: true,
								isSABR: false
							})
						);
					}

					request.method = 'POST';
				} else if (type == shaka.net.NetworkingEngine.RequestType.LICENSE) {
					const wrapped = {} as Record<string, any>;
					wrapped.context = data.video.ytjs?.innertube.session.context;
					wrapped.cpn = data.video.ytjs?.clientPlaybackNonce;
					wrapped.drmParams = decodeURIComponent(drmParams || '');
					wrapped.drmSystem = 'DRM_SYSTEM_WIDEVINE';
					wrapped.drmVideoFeature = 'DRM_VIDEO_FEATURE_SDR';
					wrapped.licenseRequest = shaka.util.Uint8ArrayUtils.toBase64(
						request.body as ArrayBuffer | ArrayBufferView
					);
					wrapped.sessionId = sessionId;
					wrapped.videoId = data.video.videoId;
					request.body = shaka.util.StringUtils.toUTF8(JSON.stringify(wrapped));
				}

				request.uris[0] = url.toString();
			});

			networkingEngine.registerResponseFilter(async (type, response, context) => {
				if (type === shaka.net.NetworkingEngine.RequestType.SEGMENT) {
					const url = new URL(response.uri);
					if (
						url.hostname.endsWith('.youtube.com') &&
						url.pathname === '/api/timedtext' &&
						url.searchParams.get('caps') === 'asr' &&
						url.searchParams.get('kind') === 'asr' &&
						url.searchParams.get('fmt') === 'vtt'
					) {
						const stringBody = new TextDecoder().decode(response.data);
						// position:0% for LTR text and position:100% for RTL text
						const cleaned = stringBody.replaceAll(/ align:start position:(?:10)?0%$/gm, '');

						/* @ts-ignore */
						response.data = new TextEncoder().encode(cleaned).buffer;
					} else {
						const sabrStreamingContext = response.headers['X-Streaming-Context'];

						if (sabrStreamingContext) {
							const { streamInfo, format, byteRange } = JSON.parse(
								atob(sabrStreamingContext)
							) as SabrStreamingContext;

							if (streamInfo) {
								const sabrRedirect = streamInfo.redirect;
								const playbackCookie = streamInfo.playbackCookie;
								const streamProtectionStatus = streamInfo.streamProtectionStatus;
								const formatInitMetadata = streamInfo.formatInitMetadata || [];
								const mainSegmentMediaHeader = streamInfo.mediaHeader;

								// If we have a redirect, follow it.
								if (sabrRedirect?.url && !response.data.byteLength) {
									let redirectUrl = new URL(sabrRedirect.url);

									serverAbrStreamingUrl = redirectUrl;
									redirectUrl = new URL(`https://sabr?___key=${fromFormat(format) || ''}`);

									const retryParameters = player!.getConfiguration().streaming.retryParameters;

									const redirectRequest = shaka.net.NetworkingEngine.makeRequest(
										[redirectUrl.toString()],
										retryParameters
									);

									// Keep range so we can slice the response (only if it's the init segment).
									if (typeof byteRange !== 'undefined') {
										redirectRequest.headers['Range'] = `bytes=${byteRange.start}-${byteRange.end}`;
									}

									const requestOperation = player!
										.getNetworkingEngine()
										?.request(type, redirectRequest, context);
									const redirectResponse = await requestOperation!.promise;

									// Modify the original response to contain the results of the redirect
									// response.
									Object.assign(response, redirectResponse);
									return;
								}

								if (playbackCookie) lastPlaybackCookie = streamInfo.playbackCookie;

								if (streamProtectionStatus && streamProtectionStatus.status === 3) {
									console.warn('[UMP] Attestation required.');
								}

								for (const metadata of formatInitMetadata) {
									const key = fromFormatInitializationMetadata(metadata);
									if (!initializedFormats.has(key)) {
										initializedFormats.set(key, {
											formatInitializationMetadata: metadata
										});
										console.log(`[SABR] Initialized format ${key}`);
									}
								}

								if (mainSegmentMediaHeader) {
									const formatKey = fromMediaHeader(mainSegmentMediaHeader);
									const initializedFormat = initializedFormats.get(formatKey);

									if (initializedFormat) {
										initializedFormat.lastSegmentMetadata = {
											formatId: mainSegmentMediaHeader.formatId!,
											startTimeMs: mainSegmentMediaHeader.startMs || 0,
											startSequenceNumber: mainSegmentMediaHeader.sequenceNumber || 1,
											endSequenceNumber: mainSegmentMediaHeader.sequenceNumber || 1,
											durationMs: mainSegmentMediaHeader.durationMs || 0
										};
									}
								}
							}
						}
					}
				} else if (type == shaka.net.NetworkingEngine.RequestType.LICENSE) {
					const wrappedString = shaka.util.StringUtils.fromUTF8(response.data);
					const wrapped = JSON.parse(wrappedString);
					const rawLicenseBase64 = wrapped.license;
					response.data = shaka.util.Uint8ArrayUtils.fromBase64(rawLicenseBase64);
				}
			});
		}

		await player.attach(playerElement);

		if (!data.video.hlsUrl) {
			let dashUrl: string = '';
			if ($companionStore) {
				dashUrl = `${$companionStore}/api/manifest/dash/id/${data.video.videoId}`;
			} else {
				dashUrl = data.video.dashUrl;
			}

			if (!data.video.fallbackPatch && (!Capacitor.isNativePlatform() || proxyVideos)) {
				dashUrl += '?local=true';
			}

			await player.load(dashUrl);

			if (data.video.captions) {
				data.video.captions.forEach(async (caption) => {
					player.addTextTrackAsync(
						caption.url.startsWith('http') ? caption.url : `${get(instanceStore)}${caption.url}`,
						caption.language_code,
						'captions',
						undefined,
						undefined,
						caption.label
					);
				});
			}

			if (data.content.timestamps) {
				let chapterWebVTT = 'WEBVTT\n\n';

				let timestampIndex = 0;
				data.content.timestamps.forEach((timestamp) => {
					let endTime: string;
					if (timestampIndex === data.content.timestamps.length - 1) {
						endTime = videoLength(data.video.lengthSeconds);
					} else {
						endTime = data.content.timestamps[timestampIndex + 1].timePretty;
					}

					chapterWebVTT += `${padTime(timestamp.timePretty)} --> ${padTime(endTime)}\n${timestamp.title.replaceAll('-', '').trim()}\n\n`;

					timestampIndex += 1;
				});

				if (timestampIndex > 0) {
					player.addChaptersTrack(
						`data:text/vtt;base64,${btoa(chapterWebVTT)}`,
						get(playerDefaultLanguage)
					);
				}
			}

			// Auto save watch progress every minute.
			watchProgressTimeout = setInterval(() => savePlayerPos(), 60000);

			if (get(sponsorBlockStore) && get(sponsorBlockCategoriesStore)) {
				const currentCategories = get(sponsorBlockCategoriesStore);

				const sponsorBlockUrl = get(sponsorBlockUrlStore);

				if (currentCategories.length > 0 && sponsorBlockUrl && sponsorBlockUrl !== '') {
					const sponsorBlock = new SponsorBlock('', { baseURL: sponsorBlockUrl });

					try {
						segments = await sponsorBlock.getSegments(
							data.video.videoId,
							get(sponsorBlockCategoriesStore) as Category[]
						);

						playerElement.addEventListener('timeupdate', () => {
							segments.forEach((segment) => {
								if (!playerElement) return;

								if (
									playerElement.currentTime >= segment.startTime &&
									playerElement.currentTime <= segment.endTime
								) {
									if (Math.round(playerElement.currentTime) >= Math.round(playerElement.duration)) {
										return;
									}
									playerElement.currentTime = segment.endTime + 1;
									if (!get(sponsorBlockDisplayToastStore)) {
										snackBarAlert = `${get(_)('skipping')} ${segment.category}`;
										ui('#snackbar-alert');
									}
								}
							});
						});
					} catch {}
				}
			}

			await loadPlayerPos();

			if (Capacitor.getPlatform() === 'android' && data.video.adaptiveFormats.length > 0) {
				const videoFormats = data.video.adaptiveFormats.filter((format) =>
					format.type.startsWith('video/')
				);

				originalOrigination = await ScreenOrientation.orientation();

				document.addEventListener('fullscreenchange', async () => {
					const isFullScreen = !!document.fullscreenElement;

					if (isFullScreen) {
						// Ensure bar color is black while in fullscreen
						await StatusBar.setBackgroundColor({ color: '#000000' });
						await NavigationBar.setColor({
							color: '#000000'
						});
						await StatusBar.setStyle({ style: Style.Dark });
					} else {
						await setStatusBarColor();
					}

					if (!get(playerAndroidLockOrientation)) return;

					if (isFullScreen && videoFormats[0].resolution) {
						const widthHeight = videoFormats[0].resolution.split('x');

						if (widthHeight.length !== 2) return;

						if (Number(widthHeight[0]) > Number(widthHeight[1])) {
							await StatusBar.setOverlaysWebView({ overlay: true });
							await StatusBar.hide();
							await NavigationBar.hide();
							await ScreenOrientation.lock({ orientation: 'landscape' });
						} else {
							await ScreenOrientation.lock({ orientation: 'portrait' });
						}
					} else {
						await StatusBar.setOverlaysWebView({ overlay: false });
						await StatusBar.show();
						await NavigationBar.show();

						await ScreenOrientation.lock({
							orientation: (originalOrigination as ScreenOrientationResult).type
						});
					}
				});
			}
		} else {
			if (data.video.fallbackPatch === 'youtubejs') {
				await player.load(data.video.dashUrl);
			} else {
				await player.load(data.video.hlsUrl + '?local=true');
			}
		}

		if (data.video.fallbackPatch === 'youtubejs') {
			snackBarAlert = get(_)('player.youtubeJsFallBack');
			ui('#snackbar-alert');
		}

		playerElement.addEventListener('volumechange', saveVolumePreference);

		restoreQualityPreference();

		const defaultLanguage = get(playerDefaultLanguage);
		if (defaultLanguage) {
			const audioLanguages = player.getAudioLanguages();
			const langCode = ISO6391.getCode(defaultLanguage);

			for (const audioLanguage of audioLanguages) {
				if (audioLanguage.startsWith(langCode)) {
					player.selectAudioLanguage(audioLanguage);
					break;
				}
			}
		}

		const overflowMenuButton = document.querySelector('.shaka-overflow-menu-button');
		if (overflowMenuButton) {
			overflowMenuButton.innerHTML = 'settings';
		}

		const backToOverflowButton = document.querySelector('.shaka-back-to-overflow-button');
		if (backToOverflowButton) {
			backToOverflowButton.innerHTML = 'arrow_back_ios_new';
		}

		Mousetrap.bind('space', () => {
			if (!playerElement) return;

			if (playerElement.paused) {
				playerElement.play();
			} else {
				playerElement.pause();
			}

			if (!document.fullscreenElement && userWantsFullscreen) {
				shakaUi.getControls()?.toggleFullScreen();
			}
			return false;
		});

		Mousetrap.bind('right', () => {
			if (!playerElement) return;
			playerElement.currentTime = playerElement.currentTime + 10;

			if (!document.fullscreenElement && userWantsFullscreen) {
				shakaUi.getControls()?.toggleFullScreen();
			}
			return false;
		});

		Mousetrap.bind('left', () => {
			if (!playerElement) return;

			playerElement.currentTime = playerElement.currentTime - 10;

			if (!document.fullscreenElement && userWantsFullscreen) {
				shakaUi.getControls()?.toggleFullScreen();
			}
			return false;
		});

		Mousetrap.bind('c', () => {
			const isVisible = player.isTextTrackVisible();
			if (isVisible) {
				player.setTextTrackVisibility(false);
			} else {
				const defaultLanguage = get(playerDefaultLanguage);
				const langCode = ISO6391.getCode(defaultLanguage);

				const tracks = player.getTextTracks();
				const subtitleTrack = tracks.find((track) => track.language === langCode);

				if (subtitleTrack) {
					player.selectTextTrack(subtitleTrack);
					player.setTextTrackVisibility(true);
				}
			}

			if (!document.fullscreenElement && userWantsFullscreen) {
				shakaUi.getControls()?.toggleFullScreen();
			}
			return false;
		});

		Mousetrap.bind('f', () => {
			if (document.fullscreenElement) {
				document.exitFullscreen();
			} else {
				shakaUi.getControls()?.toggleFullScreen();
			}
			return false;
		});

		Mousetrap.bind('shift+left', () => {
			if (!playerElement) return;

			playerElement.playbackRate = playerElement.playbackRate - 0.25;

			if (!document.fullscreenElement && userWantsFullscreen) {
				shakaUi.getControls()?.toggleFullScreen();
			}
		});

		Mousetrap.bind('shift+right', () => {
			if (!playerElement) return;

			playerElement.playbackRate = playerElement.playbackRate + 0.25;

			if (!document.fullscreenElement && userWantsFullscreen) {
				shakaUi.getControls()?.toggleFullScreen();
			}
		});
	});

	async function loadPlayerPos() {
		if (playerPosSet) return;
		playerPosSet = true;

		if (loadTimeFromUrl($page)) return;

		let toSetTime = 0;

		if (get(synciousStore) && get(synciousInstanceStore) && get(authStore)) {
			try {
				toSetTime = (await getVideoProgress(data.video.videoId))[0].time;
			} catch {}
		} else {
			if (get(playerSavePlaybackPositionStore)) {
				try {
					const playerPos = localStorage.getItem(`v_${data.video.videoId}`);
					if (playerPos && Number(playerPos) > toSetTime) {
						toSetTime = Number(playerPos);
					}
				} catch {}
			}
		}

		if (toSetTime > 0 && playerElement) playerElement.currentTime = toSetTime;
	}

	function savePlayerPos() {
		if (data.video.hlsUrl) return;

		if (
			get(playerSavePlaybackPositionStore) &&
			player &&
			playerElement &&
			playerElement.currentTime
		) {
			if (
				playerElement.currentTime < playerElement.duration - 10 &&
				playerElement.currentTime > 10
			) {
				try {
					localStorage.setItem(`v_${data.video.videoId}`, playerElement.currentTime.toString());
				} catch {}

				if (get(synciousStore) && get(synciousInstanceStore) && get(authStore)) {
					saveVideoProgress(data.video.videoId, playerElement.currentTime);
				}
			} else {
				try {
					localStorage.removeItem(`v_${data.video.videoId}`);
				} catch {}

				if (get(synciousStore) && get(synciousInstanceStore) && get(authStore)) {
					deleteVideoProgress(data.video.videoId);
				}
			}
		}
	}

	onDestroy(async () => {
		if (Capacitor.getPlatform() === 'android') {
			if (originalOrigination) {
				await StatusBar.setOverlaysWebView({ overlay: false });
				await StatusBar.show();
				await ScreenOrientation.lock({
					orientation: originalOrigination.type
				});
			}
		}
		if (watchProgressTimeout) {
			clearTimeout(watchProgressTimeout);
		}
		try {
			savePlayerPos();
		} catch (error) {}
		playerPosSet = false;
		HttpFetchPlugin.cacheManager.clearCache();

		if (playerElementResizeObserver) {
			playerElementResizeObserver.disconnect();
		}

		if (playerElement) {
			playerElement.src = '';
			playerElement.load();
		}

		if (player) {
			player.destroy();
		}

		if (shakaUi) {
			shakaUi.destroy();
		}
	});
</script>

<div
	id="shaka-container"
	class="youtube-theme"
	style="max-height: 80vh; max-width: calc(80vh * 16 / 9); overflow: hidden; position: relative; flex: 1; background-color: black;"
	data-shaka-player-container
>
	<video
		controls={false}
		autoplay={$playerAutoPlayStore}
		id="player"
		style="width: 100%; height: 100%; object-fit: contain;"
		poster={getBestThumbnail(data.video.videoThumbnails, 1251, 781)}
	></video>
</div>

{#if !isEmbed}
	<div class="snackbar" id="snackbar-alert">
		<span class="bold" style="text-transform: capitalize;">{snackBarAlert}</span>
	</div>
{/if}
