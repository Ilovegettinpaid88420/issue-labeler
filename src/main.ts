import { getInput, setFailed, debug, setOutput } from "@actions/core";
import { context, getOctokit } from "@actions/github";
import { load as loadYaml } from "js-yaml";

type GitHubClient = ReturnType<typeof getOctokit>["rest"];

let configPath;
async function run() {
  // Configuration parameters
  configPath = getInput("configuration-path", { required: true });
  const token = getInput("repo-token", { required: true });
  const enableVersionedRegex = parseInt(
    getInput("enable-versioned-regex", { required: true })
  );
  const versionedRegex = new RegExp(
    getInput("versioned-regex", { required: false })
  );
  const notBefore = Date.parse(getInput("not-before", { required: false }));
  const bodyMissingRegexLabel = getInput("body-missing-regex-label", {
    required: false,
  });
  const includeTitle = parseInt(getInput("include-title", { required: false }));
  const includeBody = parseInt(getInput("include-body", { required: false }));
  const syncLabels = parseInt(getInput("sync-labels", { required: false }));

  const issue_number = parseInt(getInput("issue-number", { required: true }))

  // A client to load data from GitHub
  const { rest: client } = getOctokit(token);

  /** List of labels to add */
  const toAdd: string[] = [];
  /** List of labels to remove */
  const toRemove: string[] = [];

  const issue = await client.issues.get({
    owner: context.repo.owner,
    repo: context.repo.repo,
    issue_number,
  });

  const issue_body = issue.data.body ?? getIssueOrPRBody();
  if (issue_body === undefined) {
    console.log("Could not get issue or PR body from API or context, exiting");
    return;
  }

  const issue_title = issue.data.title ?? getIssueOrPRTitle();
  if (!issue_title) {
    console.log("Could not get issue or PR title from API or context, exiting");
    return;
  }

  const labels: String[] = []
  issue.data.labels.forEach((label) => {
    if (typeof label === 'string') {
    } else {
      labels.push(<String>label.name);
    }
  });

  debug(`Issue has the following labels #${labels}`);

  if (enableVersionedRegex === 1) {
    const regexVersion = versionedRegex.exec(issue_body);
    if (!regexVersion || !regexVersion[1]) {
      if (bodyMissingRegexLabel) {
        await addLabels(client, issue_number, [bodyMissingRegexLabel]);
      }
      console.log(
        `Issue #${issue_number} does not contain regex version in the body of the issue, exiting.`
      );
      return;
    } else if (bodyMissingRegexLabel) {
      toRemove.push(bodyMissingRegexLabel);
    }
    configPath = regexifyConfigPath(configPath, regexVersion[1]);
  }

  // If the notBefore parameter has been set to a valid timestamp, exit if the current issue was created before notBefore
  if (notBefore) {
    const issueCreatedAt = Date.parse(issue.data.created_at);
    if (issueCreatedAt < notBefore) {
      console.log(
        "Issue is before `notBefore` configuration parameter. Exiting..."
      );
      return;
    }
  }

  // Load our regex rules from the configuration path
  const labelRegexes = await loadConfig(client, configPath);

  let issueContent = "";
  if (includeTitle === 1) issueContent += `${issue_title}\n\n`;
  if (includeBody === 1) issueContent += issue_body;

  for (const [label, globs] of labelRegexes.entries()) {
    if (checkRegexes(issueContent, globs)) {
      toAdd.push(label);
    } else if (syncLabels === 1) {
      if (labels.includes(label)) {
        debug(`Marking #${label} label for removal`);
        toRemove.push(label);
      }
    }
  }

  let promises = [];
  if (toAdd.length) {
    promises.push(addLabels(client, issue_number, toAdd));
  }

  promises = promises.concat(toRemove.map(removeLabel(client, issue_number)));

  const rejected = (await Promise.allSettled(promises))
    .map((p) => p.status === "rejected" && p.reason)
    .filter(Boolean);

  if (rejected.length) {
    throw new AggregateError(rejected)
  }

  if (toAdd.length) {
    setOutput("labels-added", toAdd);
  }

  if (toRemove.length) {
    setOutput("labels-removed", toRemove);
  }
}

function getIssueOrPRBody() {
  const { issue, pull_request } = context.payload;
  if (issue?.body === null || pull_request?.body === null) {
    return '';
  }
  return issue?.body ?? pull_request?.body;
}

function getIssueOrPRTitle(): string | undefined {
  const { issue, pull_request } = context.payload;
  return issue?.title ?? pull_request?.title;
}

function regexifyConfigPath(configPath: string, version: string) {
  const lastIndex = configPath.lastIndexOf(".");
  return `${configPath.substring(0, lastIndex)}-v${version}.yml`;
}

/** Load the configuration file */
async function loadConfig(client: GitHubClient, configPath: string) {
  try {
    const { data } = await client.repos.getContent({
      owner: context.repo.owner,
      repo: context.repo.repo,
      ref: context.sha,
      path: configPath,
    });

    if (!("content" in data)) {
      throw new TypeError(
        "The configuration path provided is not a valid file. Exiting"
      );
    }

    const configContent = Buffer.from(data.content, "base64").toString("utf8");

    // loads (hopefully) a `{[label:string]: string | string[]}`, but is `any`:
    const configObject = loadYaml(configContent);

    // transform `any` => `Map<string,string[]>` or throw if yaml is malformed:
    return getLabelRegexesMapFromObject(configObject);
  } catch (error) {
    console.log("Error loading configuration file: " + error);
    throw error;
  }
}

function getLabelRegexesMapFromObject(configObject: any) {
  const labelRegexes = new Map<string, string[]>();
  for (const label in configObject) {
    if (typeof configObject[label] === "string") {
      labelRegexes.set(label, [configObject[label]]);
    } else if (Array.isArray(configObject[label])) {
      labelRegexes.set(label, configObject[label]);
    } else {
      throw Error(
        `found unexpected type for label ${label} (should be string or array of regex)`
      );
    }
  }

  return labelRegexes;
}

function checkRegexes(issue_body: string, regexes: string[]) {
  let found;

  // If several regex entries are provided we require all of them to match for the label to be applied.
  for (const regEx of regexes) {
    const isRegEx = regEx.match(/^\/(.+)\/(.*)$/);

    if (isRegEx) {
      found = issue_body.match(new RegExp(isRegEx[1], isRegEx[2]));
    } else {
      found = issue_body.match(regEx);
    }

    if (!found) {
      return false;
    }
  }
  return true;
}

async function addLabels(
  client: GitHubClient,
  issue_number: number,
  labels: string[]
) {
  try {
    const formatted = labels.map((l) => `"${l}"`).join(", ");
    debug(`Adding label(s) (${formatted}) to issue #${issue_number}`);
    return await client.issues.addLabels({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number,
      labels,
    });
  } catch (error) {
    console.log(`Could not add label(s) ${labels} to issue #${issue_number}`);
    throw error;
  }
}

function removeLabel(client: GitHubClient, issue_number: number) {
  return async function (name: string) {
    try {
      debug(`Removing label ${name} from issue #${issue_number}`);
      return await client.issues.removeLabel({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number,
        name,
      });
    } catch (error) {
      console.log(
        `Could not remove label "${name}" from issue #${issue_number}`
      );
      throw error;
    }
  };
}

run().catch(setFailed);
