//! Early delivery of a declared startup TS resource and full-body cache commit.
#[cfg(target_os = "ios")]
use super::{is_recorded, network_policy, same_context, SERVE_SLOTS, STATE};
use super::{media, net, record, record_response, ServeTiming, MAX_RESOURCE};
use std::time::Instant;
use tauri::http::{self, Response};

#[cfg(any(target_os = "ios", test))]
pub(crate) struct StreamedTs {
    upstream: reqwest::Response,
    first: Option<bytes::Bytes>,
    buffered: Option<Vec<u8>>,
    _network_slot: tokio::sync::SemaphorePermit<'static>,
    record_slot: tokio::sync::OwnedSemaphorePermit,
    key: u64,
    target: String,
    headers_at: Instant,
    timing: ServeTiming,
}

#[cfg(target_os = "ios")]
pub(crate) async fn open_streamed_ts(key: u64, raw: &str) -> Result<Option<StreamedTs>, String> {
    let Ok(target) = network_policy::parse_target(raw) else {
        return Ok(None);
    };
    if !target.path().to_ascii_lowercase().ends_with(".ts") {
        return Ok(None);
    }
    let lookup_at = Instant::now();
    let target = target.to_string();
    let source = {
        let state = STATE.lock().unwrap();
        let Some(session) = state.sessions.get(&key).filter(|s| same_context(s)) else {
            return Ok(None);
        };
        if !session.media_urls.contains(&target) || session.resources.contains_key(&target) {
            return Ok(None);
        }
        session.source.clone()
    };
    let cache_lookup_ms = lookup_at.elapsed().as_millis();
    let queued_at = Instant::now();
    let record_slot = SERVE_SLOTS
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| "媒体请求已停止")?;
    let queue_ms = queued_at.elapsed().as_millis();

    // A cached hit that appeared while waiting should use the existing path.
    if super::source(key).is_none() || is_recorded(key, &target) {
        return Ok(None);
    }
    let opened = net::open_media_stream(&target, &source.origin, MAX_RESOURCE, |response| {
        streamable_length(response).is_some()
    })
    .await?;
    Ok(Some(StreamedTs {
        upstream: opened.response,
        first: opened.first,
        buffered: opened.buffered,
        _network_slot: opened.permit,
        record_slot,
        key,
        target,
        headers_at: Instant::now(),
        timing: ServeTiming {
            queue_ms,
            cache_lookup_ms: Some(cache_lookup_ms),
            network: Some(opened.timing),
            cache_hit: Some(false),
            ..Default::default()
        },
    }))
}

fn streamable_length(response: &reqwest::Response) -> Option<usize> {
    let expected = usize::try_from(response.content_length()?).ok()?;
    is_streamable_ts(response.status(), response.headers(), expected).then_some(expected)
}

#[cfg(any(target_os = "ios", test))]
fn is_streamable_ts(status: http::StatusCode, headers: &http::HeaderMap, length: usize) -> bool {
    status == http::StatusCode::OK
        && (1..=MAX_RESOURCE).contains(&length)
        && !headers.contains_key(http::header::CONTENT_RANGE)
        && headers
            .get(http::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.split(';').next())
            .is_some_and(|kind| kind.trim().eq_ignore_ascii_case("video/mp2t"))
}

#[cfg(any(target_os = "ios", test))]
impl StreamedTs {
    pub(crate) fn streamable_length(&self) -> Option<usize> {
        streamable_length(&self.upstream)
    }

    pub(crate) async fn finish_buffered(
        self,
        origin: &str,
    ) -> Option<(Response<Vec<u8>>, ServeTiming)> {
        let content_type = self
            .upstream
            .headers()
            .get(http::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let complete = self.upstream.status() == http::StatusCode::OK
            && !self
                .upstream
                .headers()
                .contains_key(http::header::CONTENT_RANGE);
        let final_url = self.upstream.url().clone();
        let mut timing = self.timing;
        let bytes = self.buffered?;
        let response_origin = format!("{origin}/watch/{}", self.key);
        let bytes = if complete {
            let record_at = Instant::now();
            let key = self.key;
            let target = self.target;
            let kind = content_type.clone();
            let resolved = final_url.clone();
            let (bytes, _slot) = record_response(bytes, self.record_slot, move |bytes| {
                record(key, target, kind, resolved, bytes);
            })
            .await
            .ok()?;
            timing.record_ms = Some(record_at.elapsed().as_millis());
            bytes
        } else {
            bytes
        };
        Some((
            media::segment_response(
                final_url.as_str(),
                content_type.as_deref(),
                bytes,
                &response_origin,
            ),
            timing,
        ))
    }

    pub(crate) fn chunks(
        self,
        expected: usize,
        on_first: impl FnOnce(ServeTiming) + Send + 'static,
    ) -> impl futures_util::Stream<Item = Result<bytes::Bytes, std::io::Error>> {
        futures_util::stream::unfold(
            Some((self, Vec::<u8>::new(), Some(on_first))),
            move |state| async move {
                let (mut stream, mut saved, mut on_first) = state?;
                let first_from_open = stream.first.take();
                let read_after_open = first_from_open.is_none();
                let result = match first_from_open {
                    Some(chunk) => Ok(Some(chunk)),
                    None => stream.upstream.chunk().await,
                };
                let chunk = match result {
                    Ok(Some(chunk)) if chunk.len() <= expected - saved.len() => chunk,
                    Err(error) => return Some((Err(std::io::Error::other(error)), None)),
                    _ => {
                        return Some((
                            Err(std::io::Error::new(
                                std::io::ErrorKind::UnexpectedEof,
                                "TS body length mismatch",
                            )),
                            None,
                        ))
                    }
                };
                if !chunk.is_empty() {
                    if let Some(notify) = on_first.take() {
                        if read_after_open {
                            if let Some(network) = &mut stream.timing.network {
                                network.received_first_body_byte(stream.headers_at.elapsed());
                            }
                        }
                        notify(stream.timing.clone());
                    }
                    if saved.capacity() - saved.len() < chunk.len() {
                        saved.reserve_exact(chunk.len());
                    }
                    saved.extend_from_slice(&chunk);
                }
                if saved.len() == expected {
                    let final_url = stream.upstream.url().clone();
                    let key = stream.key;
                    let target = stream.target;
                    // The verified full body is the only path to publication. We
                    // already hold a recording slot, even if the client disconnects.
                    record_response(saved, stream.record_slot, move |bytes| {
                        record(key, target, Some("video/mp2t".into()), final_url, bytes);
                    });
                    Some((Ok(chunk), None))
                } else {
                    Some((Ok(chunk), Some((stream, saved, on_first))))
                }
            },
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::watch::SERVE_SLOTS;
    use std::time::Duration;

    #[tokio::test]
    async fn startup_ts_yields_early_and_rejects_an_incomplete_body() {
        use futures_util::StreamExt;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        static NETWORK: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

        for complete in [true, false] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}/start.ts", listener.local_addr().unwrap());
            let (finish, allow_finish) = tokio::sync::oneshot::channel();
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {
                    request.push(socket.read_u8().await.unwrap());
                }
                socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: video/mp2t\r\nContent-Length: 6\r\nConnection: close\r\n\r\nabc").await.unwrap();
                allow_finish.await.unwrap();
                if complete {
                    socket.write_all(b"def").await.unwrap();
                }
            });
            let upstream = reqwest::Client::builder()
                .no_proxy()
                .build()
                .unwrap()
                .get(&url)
                .send()
                .await
                .unwrap();
            let opened = StreamedTs {
                upstream,
                first: None,
                buffered: None,
                _network_slot: NETWORK.acquire().await.unwrap(),
                record_slot: SERVE_SLOTS.clone().acquire_owned().await.unwrap(),
                key: 0,
                target: url,
                headers_at: Instant::now(),
                timing: ServeTiming::default(),
            };
            let length = opened.streamable_length().unwrap();
            let (first_seen, first_report) = tokio::sync::oneshot::channel();
            let mut chunks = Box::pin(opened.chunks(length, move |_| {
                let _ = first_seen.send(());
            }));
            let first = tokio::time::timeout(Duration::from_secs(1), chunks.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            assert_eq!(&first[..], b"abc");
            first_report.await.unwrap();
            finish.send(()).unwrap();
            let second = chunks.next().await.unwrap();
            if complete {
                assert_eq!(&second.unwrap()[..], b"def");
            } else {
                assert!(second.is_err());
            }
            assert!(chunks.next().await.is_none());
            server.await.unwrap();
        }
    }

    #[test]
    fn startup_ts_requires_an_unranged_bounded_transport_stream() {
        use http::{header, HeaderMap, HeaderValue, StatusCode};
        let mut headers = HeaderMap::new();
        headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("video/mp2t"));
        assert!(is_streamable_ts(StatusCode::OK, &headers, 6));
        assert!(!is_streamable_ts(
            StatusCode::OK,
            &headers,
            MAX_RESOURCE + 1
        ));
        assert!(!is_streamable_ts(StatusCode::PARTIAL_CONTENT, &headers, 6));
        headers.insert(
            header::CONTENT_RANGE,
            HeaderValue::from_static("bytes 0-5/6"),
        );
        assert!(!is_streamable_ts(StatusCode::OK, &headers, 6));
        headers.remove(header::CONTENT_RANGE);
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/vnd.apple.mpegurl"),
        );
        assert!(!is_streamable_ts(StatusCode::OK, &headers, 6));
    }
}
