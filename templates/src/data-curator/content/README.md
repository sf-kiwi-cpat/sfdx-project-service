# Data Curator

React prototype plus Salesforce DX starter assets for a metadata-governance app aimed at Salesforce admins.

## What is included

- A React + Vite front end inspired by the supplied dashboard and explorer concepts
- An additional `Agent Command` surface that shows how the UI can expose an Agentforce workflow
- A Salesforce DX starter structure with an Agentforce authoring bundle
- Flow and prompt-template contracts that define the action surface the agent expects

## Run the app

```bash
cp .env.example .env
npm install
npm run dev
```

`npm run dev` now starts both the Vite front end and a local Node bridge that talks to the Salesforce Agent API.

## Project structure

- `src/` React UI
- `server/` local Agent API bridge for session and message calls
- `force-app/main/default/objects/` governance support objects
- `force-app/main/default/applications/` Lightning app and navigation shell
- `force-app-flows/main/default/flows/` autolaunched Flows deployed after the Apex actions exist
- `agentforce-prompts/main/default/genAiPromptTemplates/` Prompt Builder source-format starter stubs kept as optional scaffolding
- `agentforce-bundle/main/default/aiAuthoringBundles/` Agentforce authoring bundle deployed after the flow actions exist
- `salesforce/contracts/` implementation contracts for Flow and Prompt Builder assets
- `docs/` deployment and design notes

## Notes

The Salesforce metadata in this repo is intentionally a starter kit. The Agent Script is written to current public Agentforce patterns, while the Flow and Prompt Builder contracts document the inputs and outputs you should wire up in your org before previewing the agent in live mode.

The local Salesforce CLI available in this workspace supports `sf agent`, but it does not expose the newest authoring-bundle subcommands from the latest Agentforce DX docs. If your org tooling differs, use the Agentforce Builder UI or upgrade the relevant CLI plugin before trying to validate or publish the bundle from the command line.

## Environment variables

- `SF_AGENT_DOMAIN`: your Salesforce My Domain URL, for example `https://your-domain.my.salesforce.com`
- `SF_AGENT_API_HOST`: defaults to `https://api.salesforce.com`
- `SF_AGENT_ID`: the activated Agentforce agent ID used by the Agent API
- `SF_ECA_CLIENT_ID`: external client app consumer key
- `SF_ECA_CLIENT_SECRET`: external client app consumer secret
- `SF_AGENT_BYPASS_USER`: usually `true` for client credentials flow

## Salesforce deploy

```bash
sf project deploy start --manifest manifest/package.xml --target-org <your-org-alias>
sf project deploy start --manifest manifest/flows-package.xml --target-org <your-org-alias>
sf project deploy start --source-dir agentforce-bundle/main/default --target-org <your-org-alias>
sf apex run test --tests DataCuratorGovernanceServiceTest --target-org <your-org-alias>
```

Deploy the flows second. That sequence avoids the common Flow validation issue where Salesforce can't resolve invocable Apex actions until the classes are already compiled and active in the org. The authoring bundle now depends only on those Flow actions, so prompt-template deployment is no longer on the critical path.

Optional prompt-template scaffolding deploy:

```bash
sf project deploy start --manifest manifest/prompts-package.xml --target-org <your-org-alias>
```

Prompt template note: the `GenAiPromptTemplate` files in this repo are starter scaffolds only. Prompt-template metadata remains org-sensitive, so the deploy-safe path uses flow-backed summary actions instead. If you want native Prompt Builder templates later, create or save them in your org first and then retrieve the authoritative metadata back into source.
