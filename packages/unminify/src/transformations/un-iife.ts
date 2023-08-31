import { isTopLevel } from '@unminify-kit/ast-utils'
import wrap from '../wrapAstTransformation'
import type { ASTTransformation } from '../wrapAstTransformation'
import type { Scope } from 'ast-types/lib/scope'
import type { ASTNode, ArrowFunctionExpression, CallExpression, FunctionExpression, JSCodeshift } from 'jscodeshift'

/**
 * Improve the readability of code inside IIFE.
 *
 * Further reading:
 * The purpose or the benefit of using IIFE:
 *  - Create a new scope, avoid polluting the global scope
 *  - Avoid naming conflicts
 *  - Reduce the length of the identifier (e.g. `window` -> `w`)
 *  - Avoid the need to declare a variable (e.g. `const w = window`)
 *
 * In this transformation, we will mainly focus on
 * - fix the minified short identifier (e.g. `w` -> `window`)
 * - move the value of the parameter to the top of the function
 *
 * We also have the ability to fix "Avoid the need to declare
 * a variable" by doing some analysis on the function body,
 * and replace the first assignment of the variable with the
 * parameter.
 *
 * However, it is not implemented yet.
 * And I'm not sure if it is a good idea.
 */
export const transformAST: ASTTransformation = (context) => {
    const { root, j } = context

    root
        .find(j.ExpressionStatement, {
            expression: {
                type: 'CallExpression',
                callee: {
                    type: (type: string) => {
                        return type === 'FunctionExpression'
                        || type === 'ArrowFunctionExpression'
                    },
                    params: params => params.length > 0,
                },
            },
        })
        .forEach((path) => {
            if (!isTopLevel(j, path)) return

            const expression = path.node.expression as CallExpression
            const argumentList = expression.arguments
            const callee = expression.callee as FunctionExpression | ArrowFunctionExpression
            const scope = j(callee).closestScope().get().scope as Scope | undefined
            if (!scope) return

            const len = callee.params.length
            const reversedParams = [...callee.params].reverse()

            reversedParams.forEach((param, idx) => {
                const index = len - idx - 1
                const argument = argumentList[index]
                // Only handle single character identifier
                // Longer identifier is probably not minified or it is a meaningful name
                if (j.Identifier.check(param) && param.name.length === 1) {
                    const oldName = param.name
                    const argumentsUsed = j(callee.body).find(j.Identifier, { name: 'arguments' }).size() > 0

                    // Of the argument identifier name is too short, we ignore it
                    if (j.Identifier.check(argument) && argument.name !== oldName && argument.name.length > 1) {
                        if (scope.getBindings()[oldName]) {
                            renameIdentifier(j, callee, oldName, argument.name)
                        }
                    }
                    else if (j.BlockStatement.check(callee.body) && j.Literal.check(argument)) {
                        // If `arguments` is used in the function, we can't mutate the parameter
                        if (argumentsUsed) return

                        // Remove the parameter
                        callee.params.splice(index, 1)
                        argumentList.splice(index, 1)

                        // Insert variable declaration with the parameter value
                        const variableDeclaration = j.variableDeclaration('const', [
                            j.variableDeclarator(j.identifier(oldName), argument),
                        ])
                        callee.body.body.unshift(variableDeclaration)
                    }
                }
            })
        })
}

function renameIdentifier(j: JSCodeshift, targetScopeNode: ASTNode, oldName: string, newName: string) {
    j(targetScopeNode)
        .find(j.Identifier, { name: oldName })
        .forEach((path) => {
            // Exclude MemberExpression properties
            if (path.parent.node.type === 'MemberExpression' && path.parent.node.property === path.node) return

            const pathScope = path.scope.lookup(oldName) as Scope
            const scopeNode = pathScope.getBindings()[oldName]?.[0].scope.node
            if (scopeNode === targetScopeNode && path.name !== 'property') {
                path.node.name = newName
            }
        })
}

export default wrap(transformAST)
