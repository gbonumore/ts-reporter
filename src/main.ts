import * as core from '@actions/core'
import * as github from '@actions/github'

type Claim = {
  [user: string]: {
    accountIndex: number
    amount: string
    metadata: {
      reason: string
    }
    windowIndex: number
    proof: string[]
  }
}

export type MerkleTree = {
  id: number
  rewardToken: string
  windowIndex: number
  totalRewardsDistributed: string
  merkleRoot: string
  claims: Claim
}

export type QueryResult = {
  repository: {
    object: {
      entries: {
        name: string
        type: string
        object: {
          entries: {
            name: string
            object: {
              text: string
            }
          }[]
        }
      }[]
    }
  }
}

export type MerkleTreesByMonth = {
  [month: string]: MerkleTree
}

export type MerkleTreesByUser = {
  [user: string]: {
    [month: string]: MerkleTreesByMonth['claims'] | {}
  }
}

async function run(): Promise<void> {
  try {
    const owner = core.getInput('owner', {required: true})
    const repo = core.getInput('repo', {required: true})
    const token = core.getInput('token', {required: true})
    const branchInput = core.getInput('branch', {required: true})

    const octokit = github.getOctokit(token)

    /**
     * We need to fetch the list of files that are currently present in the
     * branch we want to create a pull request for.
     */

    const merkleTrees: QueryResult = await octokit.graphql(
      `
          query RepoFiles($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        object(expression: "HEAD:reports") {
          ... on Tree {
            entries {
              name
              type
              object {
                ... on Tree {
                  entries {
                    name
                    object {
                      ... on Blob {
                        text
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }`,
      {
        owner,
        name: repo
      }
    )

    // **

    const merkleTreesByMonth = {} as MerkleTreesByMonth
    merkleTrees.repository.object.entries.map(entry => {
      return {
        [entry.name]: entry.object.entries.map(el => {
          if (el.name === 'merkle-tree.json') {
            const date = entry.name
            const merkleTree = JSON.parse(el.object.text) as MerkleTree
            merkleTreesByMonth[date] = merkleTree
          }
        })
      }
    })

    /**
     * Now we have a list of all the merkle trees by month, we need to create a new object
     * that has the user as the key and the value is an object with the month as the key
     * and the value is the claim object.
     * This will allow us to easily query the merkle tree by user and month.
     * @example
     * merkleTreesByUser['0x...1234']['2021-01'] => { accountIndex: 1, amount: '100000000000000', metadata: { reason: '...' }, windowIndex: 1, proof: [...] }
     */

    const merkleTreesByUser = {} as MerkleTreesByUser
    for (const [date, merkleTree] of Object.entries(merkleTreesByMonth)) {
      for (const [user, claim] of Object.entries(merkleTree.claims)) {
        if (!merkleTreesByUser[user]) {
          merkleTreesByUser[user] = {}
        }
        merkleTreesByUser[user][date] = claim
      }
    }

    /**
     * We now get latest ref for the current branch
     */

    const currentBranch = await octokit.rest.git.getRef({
      owner,
      repo,
      ref: `heads/${branchInput}`
    })

    /**
     * We then create a new blob with the new merkle tree file
     */

    const createBlob = await octokit.rest.git.createBlob({
      owner,
      repo,
      content: JSON.stringify(merkleTreesByUser, null, 2),
      encoding: 'utf-8'
    })

    /**
     * We then create a new tree with the new merkle tree file
     */

    const createTree = await octokit.rest.git.createTree({
      owner,
      repo,
      tree: [
        {
          path: 'reports/merkle-trees-by-user.json',
          mode: '100644',
          type: 'blob',
          sha: createBlob.data.sha
        }
      ],
      base_tree: currentBranch.data.object.sha
    })

    /**
     * We then create a new commit with the new merkle tree file
     * and the previous commit as the parent
     */

    const createCommit = await octokit.rest.git.createCommit({
      owner,
      repo,
      message: '**GENERATED** Arrange Rewards by User',
      tree: createTree.data.sha,
      parents: [currentBranch.data.object.sha]
    })

    /**
     * We then update the current branch with the new commit
     * and the previous commit as the parent
     * This will create a new commit on the current branch
     * with the new merkle tree file
     * and the previous commit as the parent
     */

    await octokit.rest.git.updateRef({
      owner,
      repo,
      ref: `heads/${branchInput}`,
      sha: createCommit.data.sha
    })
  } catch (error) {
    if (error instanceof Error) core.setFailed(error.message)
  }
}

run()
