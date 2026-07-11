from pathlib import Path
path = Path('src-tauri/src/lib.rs')
text = path.read_text(encoding='utf-8')
# Update ServerConfig struct
text = text.replace(
    '''    pub mlock: bool,
}''',
    '''    pub mlock: bool,
    pub enabled_advanced_params: Vec<String>,
}'''
)
# Update default
text = text.replace(
    '''            mlock: false,
        }
    }
}''',
    '''            mlock: false,
            enabled_advanced_params: vec!["ctx_size".into()],
        }
    }
}'''
)
# Update parse_config
old_parse = '''    Ok(ServerConfig {
        llama_server_path: get_str(&map, "llama_server_path").unwrap_or_default(),
        model: get_str(&map, "model").unwrap_or_default(),
        host: get_str(&map, "host").unwrap_or_else(|| "127.0.0.1".into()),
        port: get_u16(&map, "port").unwrap_or(8080),
        ctx_size: get_i64(&map, "ctx_size").unwrap_or(4096),
        n_predict: get_i64(&map, "n_predict").unwrap_or(-1),
        n_gpu_layers: get_i64(&map, "n_gpu_layers").unwrap_or(0),
        threads: get_i64(&map, "threads").unwrap_or(0),
        batch_size: get_i64(&map, "batch_size").unwrap_or(512),
        temp: get_f64(&map, "temp").unwrap_or(0.7),
        flash_attn: get_str(&map, "flash_attn").unwrap_or_else(|| "auto".into()),
        mmap: get_bool(&map, "mmap").unwrap_or(true),
        mlock: get_bool(&map, "mlock").unwrap_or(false),
    })'''
new_parse = '''    let mut enabled_advanced_params = get_str(&map, "enabled_advanced_params")
        .unwrap_or_default()
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>();

    if enabled_advanced_params.is_empty() {
        let optional_keys = vec![
            "n_predict", "n_gpu_layers", "threads", "batch_size", "temp", "flash_attn", "mmap", "mlock"
        ];
        for key in optional_keys {
            if map.contains_key(key) {
                enabled_advanced_params.push(key.to_string());
            }
        }
        if !enabled_advanced_params.contains(&"ctx_size".to_string()) {
            enabled_advanced_params.insert(0, "ctx_size".to_string());
        }
    } else if !enabled_advanced_params.contains(&"ctx_size".to_string()) {
        enabled_advanced_params.insert(0, "ctx_size".to_string());
    }

    Ok(ServerConfig {
        llama_server_path: get_str(&map, "llama_server_path").unwrap_or_default(),
        model: get_str(&map, "model").unwrap_or_default(),
        host: get_str(&map, "host").unwrap_or_else(|| "127.0.0.1".into()),
        port: get_u16(&map, "port").unwrap_or(8080),
        ctx_size: get_i64(&map, "ctx_size").unwrap_or(4096),
        n_predict: get_i64(&map, "n_predict").unwrap_or(-1),
        n_gpu_layers: get_i64(&map, "n_gpu_layers").unwrap_or(0),
        threads: get_i64(&map, "threads").unwrap_or(0),
        batch_size: get_i64(&map, "batch_size").unwrap_or(512),
        temp: get_f64(&map, "temp").unwrap_or(0.7),
        flash_attn: get_str(&map, "flash_attn").unwrap_or_else(|| "auto".into()),
        mmap: get_bool(&map, "mmap").unwrap_or(true),
        mlock: get_bool(&map, "mlock").unwrap_or(false),
        enabled_advanced_params,
    })'''
text = text.replace(old_parse, new_parse)
# Update build_config_text
old_build = '''    lines.push(format!("mlock = {}", config.mlock));
    lines.push(String::new());
    lines.join("\\n")'''
new_build = '''    lines.push(format!("mlock = {}", config.mlock));
    lines.push(format!(
        r#"enabled_advanced_params = "{}""#,
        escape(&config.enabled_advanced_params.join(","))
    ));
    lines.push(String::new());
    lines.join("\\n")'''
text = text.replace(old_build, new_build)
# Update start_server args
old_cmd = '''    cmd.arg("-m").arg(&config.model)
        .arg("--host").arg(&config.host)
        .arg("--port").arg(config.port.to_string())
        .arg("-c").arg(config.ctx_size.to_string())
        .arg("-n").arg(config.n_predict.to_string())
        .arg("-ngl").arg(config.n_gpu_layers.to_string())
        .arg("-t").arg(config.threads.to_string())
        .arg("-b").arg(config.batch_size.to_string())
        .arg("--temp").arg(config.temp.to_string())
        .arg("--flash-attn").arg(flash_value(&config.flash_attn))
        .arg("--timeout").arg("2400");

    if config.mmap { cmd.arg("--mmap"); } else { cmd.arg("--no-mmap"); }
    if config.mlock { cmd.arg("--mlock"); }'''
new_cmd = '''    cmd.arg("-m").arg(&config.model)
        .arg("--host").arg(&config.host)
        .arg("--port").arg(config.port.to_string())
        .arg("-c").arg(config.ctx_size.to_string())
        .arg("--timeout").arg("2400");

    if config.enabled_advanced_params.contains(&"n_predict".to_string()) {
        cmd.arg("-n").arg(config.n_predict.to_string());
    }
    if config.enabled_advanced_params.contains(&"n_gpu_layers".to_string()) {
        cmd.arg("-ngl").arg(config.n_gpu_layers.to_string());
    }
    if config.enabled_advanced_params.contains(&"threads".to_string()) {
        cmd.arg("-t").arg(config.threads.to_string());
    }
    if config.enabled_advanced_params.contains(&"batch_size".to_string()) {
        cmd.arg("-b").arg(config.batch_size.to_string());
    }
    if config.enabled_advanced_params.contains(&"temp".to_string()) {
        cmd.arg("--temp").arg(config.temp.to_string());
    }
    if config.enabled_advanced_params.contains(&"flash_attn".to_string()) {
        cmd.arg("--flash-attn").arg(flash_value(&config.flash_attn));
    }
    if config.enabled_advanced_params.contains(&"mmap".to_string()) {
        if config.mmap { cmd.arg("--mmap"); } else { cmd.arg("--no-mmap"); }
    }
    if config.enabled_advanced_params.contains(&"mlock".to_string()) {
        if config.mlock { cmd.arg("--mlock"); }
    }'''
text = text.replace(old_cmd, new_cmd)
path.write_text(text, encoding='utf-8')
