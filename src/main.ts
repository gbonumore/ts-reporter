import * as core from '@actions/core'
import * as github from '@actions/github'

type Recipient = {
  windowIndex: number
  accountIndex: number
  rewards: string
  proof: string[]
}

export type MerkleTree = {
  windowIndex: number
  chainId: number
  aggregateRewards: {
    address: string
    token: string
    decimals: number
    amount: string
    original_amount: string
    pro_rata: string
    non_active_pro_rata: string
    redistributed_total: string
    redistributed_to_stakers: string
    redistributed_transferred: string
    total_tax: string
  }
  recipients: {
    [address: string]: Recipient
  }
  root: string
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
  [month: string]: {
    veAUXO: MerkleTree
    xAUXO: MerkleTree
  }
}

// Extract the merkle tree by user and split it by 2 different tokens: veAUXO and xAUXO
export type MerkleTreesByUser = {
  [user: string]: {
    [token: string]: {
      [month: string]: Recipient
    }
  }
}

async function run(): Promise<void> {
  try {
    const owner = core.getInput('owner', {required: true})
    const repo = core.getInput('repo', {required: true})
    const ghToken = core.getInput('token', {required: true})
    const branchInput = core.getInput('branch', {required: true})

    const octokit = github.getOctokit(ghToken)

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
          if (el.name === 'merkle-tree-veAUXO.json') {
            const date = entry.name
            const merkleTree = JSON.parse(el.object.text) as MerkleTree
            merkleTreesByMonth[date]['veAUXO'] = merkleTree
          }
          if (el.name === 'merkle-tree-xAUXO.json') {
            const date = entry.name
            const merkleTree = JSON.parse(el.object.text) as MerkleTree
            merkleTreesByMonth[date]['xAUXO'] = merkleTree
          }
        })
      }
    })

    /**
     * Now we have a list of all the merkle trees by month, we need to create a new object
     * that has the user as the key and the value is an object with two keys: veAUXO and xAUXO
     * and the value is an object with the month as the key and the value is the claim
     * @example
     *       "0x123": {
     *   "veAUXO": {
     *     "2021-01": {
     *       "windowIndex": 0,
     *       "accountIndex": 0,
     *       "rewards": "0",
     *       "proof": [
     *         "0x0000000000000000000000000000000000000000000000000000000000000000"
     *       ]
     *     },
     *     "xAUXO": {
     *       "2021-01": {
     *         "windowIndex": 0,
     *         "accountIndex": 0,
     *         "rewards": "0",
     *         "proof": [
     *           "0x0000000000000000000000000000000000000000000000000000000000000000"
     *         ]
     *       },
     *     }
     *   }
     * }
     * }
     **/

    const merkleTreesByUser = {} as MerkleTreesByUser
    for (const [date, merkleTreesByToken] of Object.entries(
      merkleTreesByMonth
    )) {
      for (const [token, merkleTree] of Object.entries(merkleTreesByToken)) {
        for (const [user, recipient] of Object.entries(merkleTree.recipients)) {
          if (!merkleTreesByUser[user]) {
            merkleTreesByUser[user] = {}
          }
          if (!merkleTreesByUser[user][token]) {
            merkleTreesByUser[user][token] = {}
          }
          merkleTreesByUser[user][token][date] = recipient
        }
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
