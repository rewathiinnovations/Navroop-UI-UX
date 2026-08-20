'use client';

import { useState } from 'react';
import Link from 'next/link';
import { appConfig } from '@/config/app.config';
import { looksLikeUrl } from '@/lib/projects/prompt';

interface SidebarInputProps {
  onSubmit: (url: string, style: string, model: string, instructions?: string) => void;
  disabled?: boolean;
}

export default function SidebarInput({ onSubmit, disabled = false }: SidebarInputProps) {
  const [url, setUrl] = useState<string>('');
  const [selectedStyle, setSelectedStyle] = useState<string>('1');
  const [selectedModel, setSelectedModel] = useState<string>(appConfig.ai.defaultModel);
  const [additionalInstructions, setAdditionalInstructions] = useState<string>('');
  /**
   * Derived, never stored. This was `useState(false)` whose only writer was
   * `setIsValidUrl(false)` — the URL field it referred to had been deleted and the
   * validator left commented out above it — so the options below (style, model,
   * instructions, Scrape Site) were permanently hidden and `onSubmit` was
   * unreachable. `looksLikeUrl` is the same predicate the prompt hero and the
   * import route decide with, so a bare domain counts.
   */
  const isValidUrl = looksLikeUrl(url);

  const styles = [
    { id: '1', name: 'Glassmorphism', description: 'Frosted glass effect' },
    { id: '2', name: 'Neumorphism', description: 'Soft 3D shadows' },
    { id: '3', name: 'Brutalism', description: 'Bold and raw' },
    { id: '4', name: 'Minimalist', description: 'Clean and simple' },
    { id: '5', name: 'Dark Mode', description: 'Dark theme design' },
    { id: '6', name: 'Gradient Rich', description: 'Vibrant gradients' },
    { id: '7', name: '3D Depth', description: 'Dimensional layers' },
    { id: '8', name: 'Retro Wave', description: '80s inspired' },
  ];

  const models = appConfig.ai.availableModels.map((model) => ({
    id: model,
    name: appConfig.ai.modelDisplayNames[model] || model,
  }));

  const handleSubmit = () => {
    // `isValidUrl`, not merely non-empty: pressing Enter on "asdf" would otherwise
    // spend a credit on a clone of nothing.
    if (!isValidUrl || disabled) return;

    onSubmit(url.trim(), selectedStyle, selectedModel, additionalInstructions || undefined);

    // Reset form
    setUrl('');
    setAdditionalInstructions('');
  };

  return (
    <div className="w-full">
      <div>
        <div className="p-4 border-b border-gray-100">
          {/* link to home page with button */}
          <Link href="/dashboard">
            <button className="w-full px-3 py-2 text-xs font-medium text-gray-700 bg-white rounded border border-gray-200 focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500">
              Back to projects
            </button>
          </Link>
        </div>

        <div className="p-4">
          <label
            htmlFor="sidebar-scrape-url"
            className="block text-xs font-medium text-gray-700 mb-2"
          >
            Site to clone
          </label>
          <input
            id="sidebar-scrape-url"
            // Not `type="url"`: `looksLikeUrl` accepts a bare domain and the
            // workspace prepends the scheme, so native validation would reject
            // "example.com" before this component ever saw it.
            type="text"
            inputMode="url"
            autoComplete="url"
            spellCheck={false}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleSubmit();
              }
            }}
            disabled={disabled}
            placeholder="https://example.com"
            className="w-full px-3 py-2 text-xs text-gray-700 bg-gray-50 rounded border border-gray-200 focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500 placeholder:text-gray-400 disabled:opacity-50"
          />
        </div>

        {/* Options Section - Show when valid URL */}
        {isValidUrl && (
          <div className="p-4 space-y-4">
            {/* Style Selector */}
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-2">Style</label>
              <div className="grid grid-cols-2 gap-1.5">
                {styles.map((style) => (
                  <button
                    key={style.id}
                    onClick={() => setSelectedStyle(style.id)}
                    disabled={disabled}
                    className={`
                      py-2 px-2 rounded text-xs font-medium border transition-all text-center
                      ${
                        selectedStyle === style.id
                          ? 'border-orange-500 bg-orange-50 text-orange-900'
                          : 'border-gray-200 hover:border-gray-300 bg-white text-gray-700'
                      }
                      ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
                    `}
                  >
                    {style.name}
                  </button>
                ))}
              </div>
            </div>

            {/* Model Selector */}
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-2">AI Model</label>
              <select
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                disabled={disabled}
                className="w-full px-3 py-2 text-xs font-medium text-gray-700 bg-white rounded border border-gray-200 focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500"
              >
                {models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name}
                  </option>
                ))}
              </select>
            </div>

            {/* Additional Instructions */}
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-2">
                Additional Instructions (optional)
              </label>
              <input
                type="text"
                value={additionalInstructions}
                onChange={(e) => setAdditionalInstructions(e.target.value)}
                disabled={disabled}
                className="w-full px-3 py-2 text-xs text-gray-700 bg-gray-50 rounded border border-gray-200 focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500 placeholder:text-gray-400"
                placeholder="e.g., make it more colorful, add animations..."
              />
            </div>

            {/* Submit Button */}
            <div className="pt-2">
              <button
                onClick={handleSubmit}
                disabled={!isValidUrl || disabled}
                className={`
                  w-full py-2.5 px-4 rounded-lg text-sm font-medium transition-all
                  ${
                    isValidUrl && !disabled
                      ? 'bg-orange-500 hover:bg-orange-600 text-white'
                      : 'bg-gray-200 text-gray-400 cursor-not-allowed'
                  }
                `}
              >
                {disabled ? 'Scraping...' : 'Scrape Site'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
