mod templates;

use anyhow::Result;
use axum::{
    body::Body,
    extract::{Request, State},
    http::{header, Method, StatusCode},
    response::{Html, Response},
    routing::{get, any},
    Router,
};
use std::env;
use std::sync::Arc;
use tower_http::{cors::CorsLayer, trace::TraceLayer};
use tracing::info;

struct AppState {
    api_url: String,
    client: reqwest::Client,
}

async fn index() -> Html<String> {
    Html(templates::boot_html())
}

async fn user_page() -> Html<String> {
    Html(templates::user_html())
}

async fn node_page() -> Html<String> {
    Html(templates::node_html())
}

async fn terminal_page() -> Html<String> {
    Html(templates::terminal_html())
}

async fn api_proxy(
    State(state): State<Arc<AppState>>,
    req: Request,
) -> Result<Response, StatusCode> {
    let path = req.uri().path().to_string();
    let query = req.uri().query().map(|q| format!("?{q}")).unwrap_or_default();
    let url = format!("{}{}{}", state.api_url.trim_end_matches('/'), path, query);

    let method = req.method().clone();
    let headers = req.headers().clone();
    let body_bytes = axum::body::to_bytes(req.into_body(), 2 * 1024 * 1024)
        .await
        .map_err(|_| StatusCode::BAD_REQUEST)?;

    let mut builder = state.client.request(method.clone(), &url);
    for (name, value) in headers.iter() {
        if name == header::HOST || name == header::CONNECTION {
            continue;
        }
        builder = builder.header(name, value);
    }
    if method != Method::GET && method != Method::HEAD {
        builder = builder.body(body_bytes.to_vec());
    }

    let res = builder.send().await.map_err(|_| StatusCode::BAD_GATEWAY)?;
    let status = StatusCode::from_u16(res.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let mut response = Response::builder().status(status);
    if let Some(h) = response.headers_mut() {
        for (name, value) in res.headers().iter() {
            if name == header::TRANSFER_ENCODING {
                continue;
            }
            h.insert(name, value.clone());
        }
    }
    let bytes = res.bytes().await.map_err(|_| StatusCode::BAD_GATEWAY)?;
    Ok(response.body(Body::from(bytes)).unwrap())
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let port: u16 = env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(3000);
    let api_url = env::var("API_URL").unwrap_or_else(|_| "http://localhost:3001".into());

    let state = Arc::new(AppState {
        api_url: api_url.clone(),
        client: reqwest::Client::new(),
    });

    let app = Router::new()
        .route("/", get(index))
        .route("/user", get(user_page))
        .route("/node", get(node_page))
        .route("/terminal", get(terminal_page))
        .route("/api/{*path}", any(api_proxy))
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{port}")).await?;
    info!("Noetis Web dashboard on :{port} (API proxy → {api_url})");
    axum::serve(listener, app).await?;
    Ok(())
}
