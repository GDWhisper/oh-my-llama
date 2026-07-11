from pathlib import Path
path = Path('src/App.tsx')
text = path.read_text(encoding='utf-8')
# Update DEFAULT_CONFIG
old_default = '''const DEFAULT_CONFIG: ServerConfig = {
  llama_server_path: "",
  model: "",
  host: "127.0.0.1",
  port: 8080,
  ctx_size: 4096,
  n_predict: -1,
  n_gpu_layers: 0,
  threads: 0,
  batch_size: 512,
  temp: 0.7,
  flash_attn: "auto",
  mmap: true,
  mlock: false,
};'''
new_default = '''const DEFAULT_CONFIG: ServerConfig = {
  llama_server_path: "",
  model: "",
  host: "127.0.0.1",
  port: 8080,
  ctx_size: 4096,
  n_predict: -1,
  n_gpu_layers: 0,
  threads: 0,
  batch_size: 512,
  temp: 0.7,
  flash_attn: "auto",
  mmap: true,
  mlock: false,
  enabled_advanced_params: ["ctx_size"],
};'''
text = text.replace(old_default, new_default)
# Update loadConfig
old_load = '''  const loadConfig = async () => {
    setError(null);
    try {
      const data = await invoke<ServerConfig>("read_config");
      setConfig({
        ...DEFAULT_CONFIG,
        ...data,
        host: data.host || DEFAULT_CONFIG.host,
        flash_attn: data.flash_attn || DEFAULT_CONFIG.flash_attn,
      });
    } catch (err) {
      setError("读取配置失败");
      console.error(err);
    }
  };'''
new_load = '''  const loadConfig = async () => {
    setError(null);
    try {
      const data = await invoke<ServerConfig>("read_config");
      const enabledList = data.enabled_advanced_params || ["ctx_size"];
      const enabledSet = new Set(enabledList);
      setAdvancedEnabled((current) => {
        const next = { ...ADVANCED_DEFAULT };
        ADVANCED_ORDER.forEach((key) => {
          if (enabledSet.has(key)) {
            next[key] = true;
          }
        });
        return next;
      });
      setConfig({
        ...DEFAULT_CONFIG,
        ...data,
        host: data.host || DEFAULT_CONFIG.host,
        flash_attn: data.flash_attn || DEFAULT_CONFIG.flash_attn,
        enabled_advanced_params: enabledList,
      });
    } catch (err) {
      setError("读取配置失败");
      console.error(err);
    }
  };'''
text = text.replace(old_load, new_load)
# Update chip onClick
old_chip = '''                  <button
                    key={option.key}
                    className="chip"
                    type="button"
                    onClick={() =>
                      setAdvancedEnabled((current) => ({
                        ...current,
                        [option.key]: true,
                      }))
                    }
                  >
                    {option.label}
                  </button>'''
new_chip = '''                  <button
                    key={option.key}
                    className="chip"
                    type="button"
                    onClick={() => {
                      const key = option.key;
                      setAdvancedEnabled((current) => ({ ...current, [key]: true }));
                      setConfig((current) => {
                        if (current.enabled_advanced_params.includes(key)) {
                          return current;
                        }
                        return {
                          ...current,
                          enabled_advanced_params: [...current.enabled_advanced_params, key]
                        };
                      });
                    }}
                  >
                    {option.label}
                  </button>'''
text = text.replace(old_chip, new_chip)
# Update removeAdvancedKey
old_remove = '''  const removeAdvancedKey = (key: AdvancedKey) => {
    setAdvancedEnabled((current) => {
      const next = { ...current, [key]: false };
      const hasEnabled = ADVANCED_ORDER.some((item) => next[item]);
      if (!hasEnabled) {
        setRemovingAdvanced(false);
      }
      return next;
    });
  };'''
new_remove = '''  const removeAdvancedKey = (key: AdvancedKey) => {
    setAdvancedEnabled((current) => {
      const next = { ...current, [key]: false };
      const hasEnabled = ADVANCED_ORDER.some((item) => next[item]);
      if (!hasEnabled) {
        setRemovingAdvanced(false);
      }
      return next;
    });
    setConfig((current) => ({
      ...current,
      enabled_advanced_params: current.enabled_advanced_params.filter((item) => item !== key)
    }));
  };'''
text = text.replace(old_remove, new_remove)
path.write_text(text, encoding='utf-8')
