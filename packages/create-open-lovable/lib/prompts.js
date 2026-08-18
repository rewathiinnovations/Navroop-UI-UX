export function getPrompts(config) {
  const prompts = [];

  if (!config.name) {
    prompts.push({
      type: 'input',
      name: 'name',
      message: 'Project name:',
      default: 'my-open-lovable',
      validate: (input) => {
        if (!input || input.trim() === '') {
          return 'Project name is required';
        }
        if (!/^[a-z0-9-_]+$/i.test(input)) {
          return 'Project name can only contain letters, numbers, hyphens, and underscores';
        }
        return true;
      }
    });
  }

  if (!config.sandbox) {
    prompts.push({
      type: 'list',
      name: 'sandbox',
      message: 'Choose your sandbox provider:',
      choices: [
        {
          name: 'E2B - Full-featured development sandboxes',
          value: 'e2b',
          short: 'E2B'
        },
        {
          name: 'Modal - Serverless sandboxes',
          value: 'modal',
          short: 'Modal'
        },
        {
          name: 'Daytona - Isolated development sandboxes',
          value: 'daytona',
          short: 'Daytona'
        }
      ],
      default: 'e2b'
    });
  }

  prompts.push({
    type: 'confirm',
    name: 'configureEnv',
    message: 'Would you like to configure API keys now?',
    default: true
  });

  return prompts;
}

export function getEnvPrompts(provider) {
  const prompts = [];

  // Always include Firecrawl API key
  prompts.push({
    type: 'input',
    name: 'firecrawlApiKey',
    message: 'Firecrawl API key (for web scraping):',
    validate: (input) => {
      if (!input || input.trim() === '') {
        return 'Firecrawl API key is required for web scraping functionality';
      }
      return true;
    }
  });

  if (provider === 'e2b') {
    prompts.push({
      type: 'input',
      name: 'e2bApiKey',
      message: 'E2B API key:',
      validate: (input) => {
        if (!input || input.trim() === '') {
          return 'E2B API key is required';
        }
        return true;
      }
    });
  } else if (provider === 'modal') {
    prompts.push({
      type: 'input',
      name: 'modalTokenId',
      message: 'Modal token ID:',
      validate: (input) => input?.trim() ? true : 'Token ID is required',
    });
    prompts.push({
      type: 'input',
      name: 'modalTokenSecret',
      message: 'Modal token secret:',
      validate: (input) => input?.trim() ? true : 'Token secret is required',
    });
  } else if (provider === 'daytona') {
    prompts.push({
      type: 'input',
      name: 'daytonaApiKey',
      message: 'Daytona API key:',
      validate: (input) => input?.trim() ? true : 'API key is required',
    });
  }

  // Optional AI provider keys
  prompts.push({
    type: 'confirm',
    name: 'addAiKeys',
    message: 'Would you like to add AI provider API keys?',
    default: true
  });

  prompts.push({
    type: 'checkbox',
    name: 'aiProviders',
    message: 'Select AI providers to configure:',
    when: (answers) => answers.addAiKeys,
    choices: [
      { name: 'Anthropic (Claude)', value: 'anthropic' },
      { name: 'OpenAI (GPT)', value: 'openai' },
      { name: 'Google (Gemini)', value: 'gemini' },
      { name: 'Groq', value: 'groq' }
    ]
  });

  prompts.push({
    type: 'input',
    name: 'anthropicApiKey',
    message: 'Anthropic API key:',
    when: (answers) => answers.aiProviders && answers.aiProviders.includes('anthropic')
  });

  prompts.push({
    type: 'input',
    name: 'openaiApiKey',
    message: 'OpenAI API key:',
    when: (answers) => answers.aiProviders && answers.aiProviders.includes('openai')
  });

  prompts.push({
    type: 'input',
    name: 'geminiApiKey',
    message: 'Gemini API key:',
    when: (answers) => answers.aiProviders && answers.aiProviders.includes('gemini')
  });

  prompts.push({
    type: 'input',
    name: 'groqApiKey',
    message: 'Groq API key:',
    when: (answers) => answers.aiProviders && answers.aiProviders.includes('groq')
  });

  return prompts;
}